"""How a loan's or mortgage's payments split into principal, interest and
the rest (escrow, fees), for the Loan and Mortgage tabs.

Each debt account is split from the best source it has, in this order:

1. ``reported``: the lender's year-to-date interest and principal
   (``AccountLiability.ytd_*``, typed in by the user), used as they are
   when the range is exactly this year so far. The only exact figure.
2. ``payments``: each payment the lender posted on the account, split by
   ``mortgage_payments`` from the loan's rate, its principal and interest and
   what is owed today. Calculated, not estimated, as far as the rate
   and balance are right.
3. ``loan_details``: the amortization schedule of the property loan the
   account is linked to (``Account.linked_asset_id`` → ``Loan`` →
   ``PaymentSchedule``). Its principal, interest and escrow shares for the
   payments due in the range are applied to what was actually paid.
4. ``lender_share``: the lender's year-to-date figures as a share, applied
   to what was paid, when the range is not this year so far.
5. ``balance``: what was paid against how far the balance fell. The fall is
   principal and the rest is counted as interest, escrow included.

Everything but ``reported`` and ``payments`` is an estimate, and the
response says so.
"""
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.account_liability import AccountLiability
from app.models.asset import Loan, PaymentSchedule
from app.modules.portfolio.account_history import account_balance_series

#: Weakest last: the split of several accounts is as good as its weakest.
BASES = ("reported", "payments", "loan_details", "lender_share", "balance")


def _empty() -> dict:
    return {"principal": 0.0, "interest": 0.0, "other": 0.0, "extra": 0.0}


async def _split_one(
    db: AsyncSession,
    user_id: int,
    account: Account,
    paid: float,
    date_from: date | None,
    date_to: date,
) -> tuple[dict, str]:
    liability = await db.get(AccountLiability, account.id)
    ytd_i = float(liability.ytd_interest_paid) if liability and liability.ytd_interest_paid is not None else None
    ytd_p = float(liability.ytd_principal_paid) if liability and liability.ytd_principal_paid is not None else None
    today = date.today()

    # 1. The lender's own figures, for exactly the span they cover.
    if ytd_i is not None and ytd_p is not None and date_from == date(today.year, 1, 1) and date_to >= today:
        return {"principal": ytd_p, "interest": ytd_i, "other": max(0.0, paid - ytd_p - ytd_i)}, "reported"

    # 2. Each payment the lender posted, split from the loan's terms.
    from app.modules.portfolio.mortgage_payments import account_payment_parts, loan_terms

    parts = await account_payment_parts(db, account, date_to)
    if parts:
        rows = [p for p in parts if (date_from is None or p.date >= date_from) and p.date <= date_to]
        total = sum(p.amount for p in rows)
        if total > 0:
            # Shares of what was posted, applied to what this view counts as
            # paid (the same credits, unless a search narrowed them).
            scale = paid / total
            return {
                "principal": sum(p.principal for p in rows) * scale,
                "interest": sum(p.interest for p in rows) * scale,
                "other": sum(p.escrow for p in rows) * scale,
                "extra": sum(p.amount for p in rows if p.extra) * scale,
                "rate": (await loan_terms(db, account)).rate_pct,
            }, "payments"

    # 3. The loan details entered under Property.
    if account.linked_asset_id is not None:
        loan = await db.scalar(select(Loan).where(Loan.asset_id == account.linked_asset_id))
        if loan is not None:
            q = select(PaymentSchedule).where(
                PaymentSchedule.loan_id == loan.id, PaymentSchedule.payment_date <= date_to,
            )
            if date_from is not None:
                q = q.where(PaymentSchedule.payment_date >= date_from)
            rows = (await db.scalars(q)).all()
            p = sum(float(r.principal) for r in rows)
            i = sum(float(r.interest) for r in rows)
            e = sum(float(r.escrow or 0) for r in rows)
            if p + i + e > 0:
                return {
                    "principal": paid * p / (p + i + e),
                    "interest": paid * i / (p + i + e),
                    "other": paid * e / (p + i + e),
                }, "loan_details"

    # 4. The lender's share of interest this year, applied to the range.
    if ytd_i is not None and ytd_p is not None and ytd_i + ytd_p > 0:
        share = ytd_i / (ytd_i + ytd_p)
        return {"principal": paid * (1 - share), "interest": paid * share, "other": 0.0}, "lender_share"

    # 5. How far the balance fell.
    start = date_from or date_to - timedelta(days=3650)
    series = (await account_balance_series(db, user_id, start, date_to, account.id)).get(account.id) or []
    fell = abs(series[0]["balance"]) - abs(series[-1]["balance"]) if len(series) > 1 else 0.0
    principal = min(max(fell, 0.0), paid)
    return {"principal": principal, "interest": paid - principal, "other": 0.0}, "balance"


async def split_debt_payments(
    db: AsyncSession,
    user_id: int,
    accounts: list[Account],
    paid_by_account: dict[int, float],
    unassigned: float,
    date_from: date | None,
    date_to: date | None,
) -> dict:
    """Principal, interest and other for the payments on ``accounts``.

    ``paid_by_account`` is each account's payments; ``unassigned`` is what
    was paid from a bank account with no lender credit to tie it to one of
    several debts. It is split in the same shares as the rest.
    """
    end = min(date_to or date.today(), date.today())
    if len(accounts) == 1 and unassigned:
        only = accounts[0].id
        paid_by_account = {**paid_by_account, only: paid_by_account.get(only, 0.0) + unassigned}
        unassigned = 0.0

    total = _empty()
    worst = -1
    rates: set[float] = set()
    for account in accounts:
        paid = paid_by_account.get(account.id, 0.0)
        if paid <= 0:
            continue
        part, basis = await _split_one(db, user_id, account, paid, date_from, end)
        for k in total:
            total[k] += part.get(k, 0.0)
        if part.get("rate") is not None:
            rates.add(round(float(part["rate"]), 3))
        worst = max(worst, BASES.index(basis))

    if unassigned:
        assigned = total["principal"] + total["interest"] + total["other"]
        if assigned > 0:
            for k in ("principal", "interest", "other"):
                total[k] += unassigned * total[k] / assigned
        else:
            total["other"] += unassigned
        worst = max(worst, BASES.index("balance"))

    if worst < 0:
        return {"principal": 0.0, "interest": 0.0, "other": 0.0, "extra": 0.0, "basis": None, "estimated": False}
    basis = BASES[worst]
    return {
        **{k: round(v, 2) for k, v in total.items()},
        "basis": basis,
        "estimated": basis not in ("reported", "payments"),
        # The rate the payments were split with, when there is one.
        "rate": next(iter(rates)) if len(rates) == 1 else None,
    }

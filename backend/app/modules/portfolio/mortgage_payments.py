"""A mortgage's payments split one by one into principal, interest and
escrow, from the loan's rate, its monthly principal and interest, and what
is owed today.

A lender posts each payment on the loan account as a credit: the regular
payment ("PAYMENT $3,150.00") and, when the borrower pays more toward the
principal, a separate credit ("PRINCIPAL PAYMENT $200"). Walking those credits
back from today's balance gives the balance before each one, and so its
interest; no balance history and no year-to-date figures from the lender are
needed. ``debt_split`` uses this as its ``payments`` source, the balance
history of a loan account is drawn from it, and the loan details take their
escrow and extra principal from it.
"""
import re
from dataclasses import dataclass
from datetime import date
from statistics import median

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.account_liability import AccountLiability
from app.models.asset import Loan
from app.models.transaction import Transaction

#: A credit that names principal and nothing else is an extra principal payment.
_PRINCIPAL_ONLY = re.compile(r"\bprincipal\b|\bprin\b|\bcurtailment\b", re.IGNORECASE)
_NOT_PRINCIPAL_ONLY = re.compile(r"\binterest\b|\bescrow\b", re.IGNORECASE)


@dataclass
class LoanTerms:
    """What the walk needs: the annual rate (percent), the monthly principal
    and interest, and what is owed now."""
    rate_pct: float
    payment_pi: float
    balance_now: float

    @property
    def monthly_rate(self) -> float:
        return self.rate_pct / 100 / 12


@dataclass
class PaymentPart:
    transaction_id: int
    date: date
    amount: float
    principal: float
    interest: float
    escrow: float
    #: A principal-only payment, over and above the regular one.
    extra: bool
    balance_before: float
    balance_after: float


def monthly_pi(principal: float, rate_pct: float, term_months: int) -> float:
    """The fixed monthly principal and interest of a loan on its original terms."""
    r = rate_pct / 100 / 12
    if term_months <= 0:
        return 0.0
    if r == 0:
        return principal / term_months
    return principal * r / (1 - (1 + r) ** -term_months)


async def loan_terms(db: AsyncSession, account: Account) -> LoanTerms | None:
    """The terms of the loan behind ``account``: the linked property's loan
    first, then the liability details the user entered. None without a rate, the
    original amount and term, and a balance."""
    owed = abs(float(account.current_balance)) if account.current_balance is not None else None
    loan = None
    if account.linked_asset_id is not None:
        loan = await db.scalar(select(Loan).where(Loan.asset_id == account.linked_asset_id))
    if loan is not None and loan.rate_apr is not None and loan.term_months:
        if owed is None and loan.balance_override is not None:
            owed = float(loan.balance_override)
        pi = monthly_pi(float(loan.principal), float(loan.rate_apr), int(loan.term_months))
        if owed is not None and pi > 0:
            return LoanTerms(float(loan.rate_apr), pi, owed)
    liability = await db.get(AccountLiability, account.id)
    if (
        liability is not None and liability.apr_pct is not None
        and liability.origination_principal is not None and liability.term_months
        and owed is not None
    ):
        pi = monthly_pi(float(liability.origination_principal), float(liability.apr_pct), int(liability.term_months))
        if pi > 0:
            return LoanTerms(float(liability.apr_pct), pi, owed)
    return None


def is_principal_only(description: str | None, amount: float, payment_pi: float) -> bool:
    """A credit toward principal alone: it says so, or it is well under the
    regular payment (an extra payment with a bank's own wording)."""
    text = description or ""
    if _PRINCIPAL_ONLY.search(text) and not _NOT_PRINCIPAL_ONLY.search(text):
        return True
    return amount < payment_pi * 0.5


def split_credits(
    credits: list[tuple[int, date, float, str | None]],
    terms: LoanTerms,
) -> list[PaymentPart]:
    """Each credit as principal, interest and escrow, oldest first.

    ``credits`` are the loan account's credits up to today, as
    ``(transaction id, date, amount, description)``. The walk runs from the
    newest back: for a regular payment, interest is the balance before it at
    the monthly rate, principal is the rest of the principal and interest, and
    what is left over is escrow. Solved for the balance before, that is
    principal = (P&I − r × balance after) ÷ (1 + r). A payment under the
    principal and interest pays interest first. On one day, an extra
    principal payment is taken to land after the regular one.
    """
    r = terms.monthly_rate
    pi = terms.payment_pi
    ordered = sorted(
        credits,
        key=lambda c: (c[1], 0 if not is_principal_only(c[3], c[2], pi) else 1, c[0]),
        reverse=True,
    )
    after = terms.balance_now
    parts: list[PaymentPart] = []
    for tid, day, amount, description in ordered:
        if amount <= 0:
            continue
        if is_principal_only(description, amount, pi):
            principal, interest, escrow, extra = amount, 0.0, 0.0, True
        elif amount >= pi:
            principal = (pi - r * after) / (1 + r)
            interest = pi - principal
            escrow = amount - pi
            extra = False
        else:
            interest = r * (after + amount) / (1 + r)
            principal = amount - interest
            escrow = 0.0
            extra = False
        principal = round(max(principal, 0.0), 2)
        interest = round(max(interest, 0.0), 2)
        # The parts always add up to the payment to the cent.
        escrow = round(max(amount - principal - interest, 0.0), 2) if escrow > 0 else 0.0
        before = after + principal
        parts.append(PaymentPart(
            transaction_id=tid, date=day, amount=round(amount, 2),
            principal=principal, interest=interest, escrow=escrow,
            extra=extra, balance_before=round(before, 2), balance_after=round(after, 2),
        ))
        after = before
    parts.reverse()
    return parts


async def account_payment_parts(
    db: AsyncSession, account: Account, until: date | None = None,
) -> list[PaymentPart] | None:
    """The split of every credit on a loan account up to ``until`` (today by
    default), oldest first, or None when the loan's terms are unknown."""
    terms = await loan_terms(db, account)
    if terms is None:
        return None
    until = until or date.today()
    rows = (await db.execute(
        select(Transaction.id, Transaction.date_posted, Transaction.amount, Transaction.description)
        .where(
            Transaction.account_id == account.id,
            Transaction.amount > 0,
            Transaction.pending.is_not(True),
            Transaction.date_posted <= until,
        )
    )).all()
    return split_credits([(r.id, r.date_posted, float(r.amount), r.description) for r in rows], terms)


def balance_on(parts: list[PaymentPart], day: date, balance_now: float) -> float:
    """What was owed at the end of ``day``, from the walk."""
    owed = parts[0].balance_before if parts else balance_now
    for p in parts:
        if p.date <= day:
            owed = p.balance_after
        else:
            break
    return owed if parts else balance_now


@dataclass
class Inferred:
    """Loan details read from the payments themselves."""
    escrow_monthly: float | None
    extra_principal_monthly: float | None


def infer_from_payments(parts: list[PaymentPart], today: date | None = None) -> Inferred:
    """Escrow: what the last three regular payments carried beyond principal
    and interest (their median). Extra principal: the principal-only payments
    of the last six whole months, as a monthly average."""
    today = today or date.today()
    regular = [p for p in parts if not p.extra]
    escrow = round(median([p.escrow for p in regular[-3:]]), 2) if regular else None
    first_of_month = date(today.year, today.month, 1)
    y, m = divmod(today.year * 12 + today.month - 1 - 6, 12)
    six_months_ago = date(y, m + 1, 1)
    extras = [p.amount for p in parts if p.extra and six_months_ago <= p.date < first_of_month]
    extra = round(sum(extras) / 6, 2) if parts else None
    return Inferred(escrow_monthly=escrow, extra_principal_monthly=extra)

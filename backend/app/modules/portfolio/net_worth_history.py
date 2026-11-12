"""Reconstruct daily net worth from historical transaction balances + price history."""
import bisect
import json
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.account_balance import AccountBalanceSnapshot
from app.models.asset import Asset
from app.models.holding import Holding
from app.models.security import PriceHistory
from app.models.transaction import Transaction

# Account classification is shared with the summary card and the breakdown
# table so all three views agree. See modules/portfolio/valuation.
from app.modules.portfolio.balance_history import AmountsByDate, balance_before
from app.modules.portfolio.valuation import (
    INVESTMENT_TYPES,
    LOAN_TYPES,
    claims_account,
    current_loan_balance,
    is_asset_backed_loan_account,
    loan_balance_at,
    ownership_share,
)


def _latest_on_or_before(
    sorted_pairs: list[tuple[date, float]], target: date
) -> Optional[float]:
    """Binary search for the most recent value at or before `target`."""
    keys = [p[0] for p in sorted_pairs]
    idx = bisect.bisect_right(keys, target) - 1
    return sorted_pairs[idx][1] if idx >= 0 else None


def _price_on(sorted_pairs: list[tuple[date, float]], target: date) -> Optional[float]:
    """The price on ``target``, or the first one known when ``target`` is earlier.

    A security Paiso only started pricing recently (a fund linked yesterday,
    whose closes are fetched from the link date on) had no value at all before
    its first close, so a new 401(k) was missing from every earlier day and
    the trend showed tens of thousands of dollars appearing at once.
    The shares are already carried flat, so the price is too.
    """
    price = _latest_on_or_before(sorted_pairs, target)
    if price is None and sorted_pairs:
        return sorted_pairs[0][1]
    return price


def _loan_before_anchor(loan, current: date) -> float:
    """A loan's balance on a day before the user (or the linked account)
    anchored it, worked back from the anchor along the schedule.

    The schedule alone starts from the original amount: a mortgage linked
    today read its original amount on every earlier day and fell to the real balance on the
    day it synced. Worked back from the anchor, the line keeps the
    schedule's shape and meets the anchor without a jump.
    """
    anchor = float(loan.balance_override)
    # The schedule is re-projected from the anchor, so it has nothing before
    # it; the amortization formula is used at both ends, like for like.
    worked = (
        loan_balance_at(loan, current, schedule=[])
        - loan_balance_at(loan, loan.balance_override_date, schedule=[])
        + anchor
    )
    return max(0.0, min(worked, float(loan.principal or worked)))


async def reconstruct_net_worth(
    db: AsyncSession,
    user_id: int,
    cutoff: date,
    end_date: date,
) -> list[dict]:
    """Return a daily series of {date, net_worth, total_assets, total_liabilities}.

    Sources (in priority order per component):
      Cash / Savings   → Transaction.balance carry-forward; fallback: Account.current_balance
      Credit Cards     → same (negated for liability side)
      Investments      → PriceHistory.close × Holding.shares (carry-forward price)
      Mortgages        → PaymentSchedule.balance carry-forward; fallback: Loan.balance_override
      Property / Other → current_value × ownership_pct  (flat — no history available)
      Manual inv. bal. → Account.current_balance for investment accounts with no
                         holdings (flat — no history available)
    """
    total_days = (end_date - cutoff).days + 1
    # Reduce granularity for very long ranges to keep response fast
    if total_days > 730:
        step = 14
    elif total_days > 365:
        step = 7
    else:
        step = 1

    # ── Accounts ──────────────────────────────────────────────────────────────
    accounts = (await db.scalars(
        select(Account).where(Account.user_id == user_id)
    )).all()

    cash_ids = [a.id for a in accounts if a.account_type in {"checking", "savings"}]
    cc_ids   = [a.id for a in accounts if a.account_type == "credit_card"]
    # Includes `mortgage`, which every earlier copy of these sets omitted, and
    # excludes loan accounts whose debt already arrives via a linked Asset's
    # Loan in the mortgage block below.
    loan_ids = [
        a.id for a in accounts
        if a.account_type in LOAN_TYPES and not is_asset_backed_loan_account(a)
    ]
    loan_id_set = set(loan_ids)
    mortgage_account_ids = {a.id for a in accounts if a.account_type == "mortgage"}
    # fallback constant balances (Account.current_balance)
    cash_fallback: dict[int, float] = {
        a.id: float(a.current_balance) for a in accounts
        if a.account_type in {"checking", "savings"} and a.current_balance is not None
    }
    cc_fallback: dict[int, float] = {
        a.id: float(a.current_balance) for a in accounts
        if a.account_type == "credit_card" and a.current_balance is not None
    }
    loan_fallback: dict[int, float] = {
        a.id: float(a.current_balance) for a in accounts
        if a.id in loan_id_set and a.current_balance is not None
    }

    # ── Transaction balances ──────────────────────────────────────────────────
    all_cash_cc_ids = cash_ids + cc_ids + loan_ids
    txn_by_acct: dict[int, list[tuple[date, float]]] = {}
    if all_cash_cc_ids:
        txn_rows = (await db.execute(
            select(Transaction.account_id, Transaction.date_posted, Transaction.balance)
            .where(
                Transaction.account_id.in_(all_cash_cc_ids),
                Transaction.balance.isnot(None),
            )
            .order_by(Transaction.account_id, Transaction.date_posted, Transaction.id)
        )).all()
        for acct_id, txn_date, balance in txn_rows:
            txn_by_acct.setdefault(acct_id, []).append((txn_date, float(balance)))

        # Balances observed on an import or typed in by hand. Imported
        # transactions often carry no running balance, so for such an account
        # these are the only record of an earlier day. Merged with the running
        # balances above into one dated list per account; on a day that has
        # both, the observed balance is placed last and so is the one used.
        snapshot_rows = (await db.execute(
            select(
                AccountBalanceSnapshot.account_id,
                AccountBalanceSnapshot.as_of,
                AccountBalanceSnapshot.balance,
            ).where(AccountBalanceSnapshot.account_id.in_(all_cash_cc_ids))
        )).all()
        for acct_id, as_of, balance in snapshot_rows:
            txn_by_acct.setdefault(acct_id, []).append((as_of, float(balance)))
        if snapshot_rows:
            for pairs in txn_by_acct.values():
                pairs.sort(key=lambda p: p[0])  # stable: a day's snapshot stays last

    # ── Settled amounts, for the days before any balance is known ─────────────
    # Cash and cards only. A loan payment is part interest, so a loan's
    # transactions do not add up to its balance.
    amounts_by_acct: dict[int, AmountsByDate] = {}
    if cash_ids or cc_ids:
        amount_rows = (await db.execute(
            select(Transaction.account_id, Transaction.date_posted, Transaction.amount)
            .where(
                Transaction.account_id.in_(cash_ids + cc_ids),
                Transaction.pending == False,  # noqa: E712
            )
        )).all()
        dated: dict[int, list[tuple[date, float]]] = {}
        for acct_id, posted, amount in amount_rows:
            dated.setdefault(acct_id, []).append((posted, float(amount or 0)))
        amounts_by_acct = {acct_id: AmountsByDate(rows) for acct_id, rows in dated.items()}

    today = date.today()
    balance_dates = {a.id: a.balance_as_of for a in accounts}

    def _worked_back(aid: int, current: date, fallback: Optional[float], owed: bool) -> Optional[float]:
        """The balance on a day earlier than anything recorded for the account,
        from its earliest recorded balance less what has posted since. A card's
        balance is an amount owed, which money in reduces, so it is turned to
        the ledger's sign for the sum and back again after."""
        known = txn_by_acct.get(aid)
        if known:
            anchor_date, anchor = known[0]
        elif fallback is not None:
            anchor_date, anchor = balance_dates.get(aid) or today, fallback
        else:
            return None
        amounts = amounts_by_acct.get(aid)
        if amounts is None or current >= anchor_date:
            return anchor
        if owed:
            return max(0.0, -balance_before(anchor_date, -abs(anchor), amounts, current))
        return balance_before(anchor_date, anchor, amounts, current)

    # ── Holdings & price history ──────────────────────────────────────────────
    all_acct_ids = [a.id for a in accounts]
    holdings = (await db.scalars(
        select(Holding).where(
            Holding.account_id.in_(all_acct_ids),
            Holding.exclude_from_net_worth == False,  # noqa: E712
        )
    )).all() if all_acct_ids else []
    # An account excluded from net worth counts for nothing, as the summary
    # counts it.
    by_id = {a.id: a for a in accounts}
    holdings = [h for h in holdings
                if not getattr(by_id.get(h.account_id), "exclude_from_net_worth", False)]

    security_ids = list({h.security_id for h in holdings})
    shares_by_sec: dict[int, float] = {}
    for h in holdings:
        shares_by_sec[h.security_id] = shares_by_sec.get(h.security_id, 0.0) + float(h.shares or 0)

    price_by_sec: dict[int, list[tuple[date, float]]] = {}
    if security_ids:
        ph_rows = (await db.execute(
            select(PriceHistory.security_id, PriceHistory.as_of, PriceHistory.close)
            .where(
                PriceHistory.security_id.in_(security_ids),
                PriceHistory.as_of <= end_date,
            )
            .order_by(PriceHistory.as_of)
        )).all()
        for sec_id, as_of, close in ph_rows:
            if close is not None:
                price_by_sec.setdefault(sec_id, []).append((as_of, float(close)))

    # ── Assets: property + other + mortgages ──────────────────────────────────
    assets = (await db.scalars(
        select(Asset)
        .where(Asset.user_id == user_id)
    )).all()

    flat_asset_value = 0.0          # property + other (constant)
    # (Loan, the user's ownership share) for the historical balance calc. The
    # share scales the loan exactly as it scales the asset's value.
    mortgage_loans: list = []

    for a in assets:
        meta = {}
        try:
            meta = json.loads(a.metadata_json) if a.metadata_json else {}
        except Exception:
            pass
        if meta.get("exclude_from_net_worth"):
            continue
        val = float(a.current_value or 0) * ownership_share(a)
        flat_asset_value += val

        if a.loan:
            mortgage_loans.append((a.loan, ownership_share(a)))

    # ── Balance-backed investment accounts: flat constant ─────────────────────
    # Investment accounts with a manual current_balance but no holdings are
    # counted by get_portfolio_summary; mirror that here so the trend agrees.
    # Skip accounts whose value comes from holdings or an "Other funds" value
    # to avoid double-counting.
    # Only positions actually held claim an account (see claims_account).
    accounts_with_holdings = {h.account_id for h in holdings if claims_account(h.shares)}
    # A hand-kept plan's "Other funds" value counts flat, as entered, beside
    # whatever tickers the account holds.
    other_funds = {
        a.id: float(a.other_funds_value) for a in accounts
        if (a.account_type in INVESTMENT_TYPES
            and a.other_funds_value is not None)
    }
    flat_investment_balance = sum(other_funds.values())

    for a in accounts:
        if a.account_type not in INVESTMENT_TYPES:
            continue
        if a.current_balance is None or a.exclude_from_net_worth:
            continue
        if a.id in accounts_with_holdings or a.id in other_funds:
            continue
        bal = float(a.current_balance)
        if bal <= 0:
            continue
        flat_investment_balance += bal

    # ── Build daily series ─────────────────────────────────────────────────────
    series = []
    current = cutoff
    while current <= end_date:
        # Cash
        cash_total = 0.0
        for aid in cash_ids:
            bal = _latest_on_or_before(txn_by_acct.get(aid, []), current)
            if bal is None:
                bal = _worked_back(aid, current, cash_fallback.get(aid), owed=False)
            if bal is not None:
                cash_total += bal

        # Credit cards (liability — store as positive amount owed)
        cc_total = 0.0
        for aid in cc_ids:
            bal = _latest_on_or_before(txn_by_acct.get(aid, []), current)
            if bal is None:
                bal = _worked_back(aid, current, cc_fallback.get(aid), owed=True)
            if bal is not None:
                cc_total += abs(bal)

        # Loans (liability)
        loan_total = 0.0
        # The part of loan_total owed on mortgage accounts, so the by-kind
        # figures below can put it with the other mortgages.
        mortgage_account_total = 0.0
        for aid in loan_ids:
            bal = _latest_on_or_before(txn_by_acct.get(aid, []), current)
            if bal is None:
                bal = loan_fallback.get(aid)
            if bal is not None:
                loan_total += abs(bal)
                if aid in mortgage_account_ids:
                    mortgage_account_total += abs(bal)

        # Investments (carry-forward price)
        inv_total = 0.0
        for sec_id, shares in shares_by_sec.items():
            price = _price_on(price_by_sec.get(sec_id, []), current)
            if price is not None:
                inv_total += shares * price

        # Mortgages (mathematically-derived balance so it works even without
        # payment schedule). From the day a user anchored the balance onward,
        # the anchor applies — otherwise the chart's last point disagrees
        # with the summary card's liabilities.
        mortgage_total = 0.0
        for loan, share in mortgage_loans:
            has_anchor = loan.balance_override is not None
            anchored = has_anchor and (
                loan.balance_override_date is None or current >= loan.balance_override_date
            )
            if anchored:
                balance = current_loan_balance(loan, current)
            elif has_anchor:
                balance = _loan_before_anchor(loan, current)
            else:
                balance = loan_balance_at(loan, current)
            mortgage_total += share * balance

        total_assets = cash_total + inv_total + flat_asset_value + flat_investment_balance
        total_liabilities = cc_total + loan_total + mortgage_total
        net_worth = total_assets - total_liabilities

        series.append({
            "date": current.isoformat(),
            "net_worth": round(net_worth, 2),
            "total_assets": round(total_assets, 2),
            "total_liabilities": round(total_liabilities, 2),
            # The same totals by kind of account, for the balance trend on
            # Transactions. Property and other assets are in total_assets but
            # are not an account type, so they have no line here.
            "cash": round(cash_total, 2),
            "investments": round(inv_total + flat_investment_balance, 2),
            "credit_cards": round(cc_total, 2),
            "loans": round(loan_total - mortgage_account_total, 2),
            "mortgages": round(mortgage_total + mortgage_account_total, 2),
        })
        current += timedelta(days=step)

    return series

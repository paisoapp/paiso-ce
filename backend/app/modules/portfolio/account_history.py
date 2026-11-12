"""One account's balance over time, for the sparkline on its card and the
chart in its drawer.

The net worth trend answers the same question for every account at once and
adds the answers up; this keeps them apart. The rules are the trend's:

- a balance observed that day, or a statement's running balance, wins;
- failing that the last one before it is carried forward;
- before the first of them, a cash or card balance is worked back from the
  transactions (see ``balance_history``), and a loan's from the payments its
  lender posted (see ``mortgage_payments``);
- an investment account that holds positions is today's shares at each day's
  closing price, or, for a security no quote source prices (a 401(k) trust
  under a made-up ticker), the last price stored for it;
- anything else is level at the balance on record.

Debts come back as positive amounts owed.
"""
import bisect
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.account_balance import AccountBalanceSnapshot
from app.models.holding import Holding
from app.models.security import PriceHistory
from app.models.transaction import Transaction
from app.modules.portfolio.balance_history import AmountsByDate, balance_before
from app.modules.portfolio.valuation import (
    CASH_TYPES,
    CREDIT_CARD_TYPES,
    DEBT_TYPES,
    INVESTMENT_TYPES,
    claims_account,
)


def _on_or_before(pairs: list[tuple[date, float]], day: date) -> float | None:
    idx = bisect.bisect_right([p[0] for p in pairs], day) - 1
    return pairs[idx][1] if idx >= 0 else None


def _days(start: date, end: date) -> list[date]:
    """Daily up to about a year, then weekly, always ending on ``end``."""
    step = 1 if (end - start).days <= 400 else 7
    days = []
    current = end
    while current >= start:
        days.append(current)
        current -= timedelta(days=step)
    return days[::-1]


async def account_balance_series(
    db: AsyncSession,
    user_id: int,
    start: date,
    end: date,
    account_id: int | None = None,
    include_excluded: bool = False,
) -> dict[int, list[dict]]:
    """``{account_id: [{"date", "balance"}, ...]}`` for the user's accounts, or
    for one of them. An account with no balance on record is left out.

    ``include_excluded`` values an account with the holdings and plans the
    user excluded from net worth too: Investments charts an account at its
    market value, where exclusion changes nothing."""
    query = select(Account).where(Account.user_id == user_id)
    if account_id is not None:
        query = query.where(Account.id == account_id)
    accounts = (await db.scalars(query)).all()
    if not accounts:
        return {}
    ids = [a.id for a in accounts]

    # Balances on record, per account, in date order. On a day with both a
    # statement balance and an observed one, the observed one is placed last
    # and so is the one read.
    known: dict[int, list[tuple[date, float]]] = {}
    for aid, posted, balance in (await db.execute(
        select(Transaction.account_id, Transaction.date_posted, Transaction.balance)
        .where(Transaction.account_id.in_(ids), Transaction.balance.isnot(None))
        .order_by(Transaction.account_id, Transaction.date_posted, Transaction.id)
    )).all():
        known.setdefault(aid, []).append((posted, float(balance)))
    for aid, as_of, balance in (await db.execute(
        select(
            AccountBalanceSnapshot.account_id,
            AccountBalanceSnapshot.as_of,
            AccountBalanceSnapshot.balance,
        ).where(AccountBalanceSnapshot.account_id.in_(ids))
    )).all():
        known.setdefault(aid, []).append((as_of, float(balance)))
    for pairs in known.values():
        pairs.sort(key=lambda p: p[0])

    # Settled amounts, for working a cash or card balance back.
    worked_back_ids = [a.id for a in accounts if a.account_type in CASH_TYPES | CREDIT_CARD_TYPES]
    amounts: dict[int, AmountsByDate] = {}
    if worked_back_ids:
        dated: dict[int, list[tuple[date, float]]] = {}
        for aid, posted, amount in (await db.execute(
            select(Transaction.account_id, Transaction.date_posted, Transaction.amount)
            .where(
                Transaction.account_id.in_(worked_back_ids),
                Transaction.pending == False,  # noqa: E712
            )
        )).all():
            dated.setdefault(aid, []).append((posted, float(amount or 0)))
        amounts = {aid: AmountsByDate(rows) for aid, rows in dated.items()}

    # Positions, for investment accounts valued by what they hold.
    shares: dict[int, dict[int, float]] = {}
    investment_ids = [a.id for a in accounts if a.account_type in INVESTMENT_TYPES]
    if investment_ids:
        for h in (await db.scalars(
            select(Holding).where(
                Holding.account_id.in_(investment_ids),
                *([] if include_excluded else [Holding.exclude_from_net_worth == False]),  # noqa: E712
            )
        )).all():
            if claims_account(h.shares):
                per_security = shares.setdefault(h.account_id, {})
                per_security[h.security_id] = per_security.get(h.security_id, 0.0) + float(h.shares or 0)
    prices: dict[int, list[tuple[date, float]]] = {}
    security_ids = sorted({sid for held in shares.values() for sid in held})
    if security_ids:
        for sid, as_of, close in (await db.execute(
            select(PriceHistory.security_id, PriceHistory.as_of, PriceHistory.close)
            .where(PriceHistory.security_id.in_(security_ids), PriceHistory.as_of <= end)
            .order_by(PriceHistory.as_of)
        )).all():
            if close is not None:
                prices.setdefault(sid, []).append((as_of, float(close)))

    def _price_on(sid: int, day: date) -> float | None:
        series_ = prices.get(sid, [])
        return _on_or_before(series_, day)

    # A loan's balance before the first one on record, walked back through
    # the payments its lender posted: without it a mortgage read flat
    # at today's balance all year.
    from app.modules.portfolio.mortgage_payments import account_payment_parts, balance_on

    walked: dict[int, list] = {}
    for a in accounts:
        if a.account_type in DEBT_TYPES and a.account_type not in CREDIT_CARD_TYPES:
            parts = await account_payment_parts(db, a, end)
            if parts:
                walked[a.id] = parts

    today = date.today()
    days = _days(start, end)
    out: dict[int, list[dict]] = {}
    for a in accounts:
        owed = a.account_type in DEBT_TYPES
        current = float(a.current_balance) if a.current_balance is not None else None
        held = shares.get(a.id)
        points = known.get(a.id, [])
        # A hand-kept plan's "Other funds": the value the user entered, from the
        # day they entered it; the value before that, before it.
        other = (float(a.other_funds_value)
                 if a.account_type in INVESTMENT_TYPES and a.other_funds_value is not None
                 else None)
        other_prev = float(a.other_funds_prev_value) if a.other_funds_prev_value is not None else other

        def other_on(day: date) -> float:
            if other is None:
                return 0.0
            if a.other_funds_as_of and day < a.other_funds_as_of:
                return other_prev or 0.0
            return other

        series = []
        for day in days:
            if other is not None and not held:
                series.append({"date": day.isoformat(), "balance": round(other_on(day), 2)})
                continue
            if held:
                # A security with no price yet contributes nothing that day.
                priced = [(_price_on(sid, day), qty) for sid, qty in held.items()]
                value = sum(p * qty for p, qty in priced if p is not None) + other_on(day)
                if not any(p is not None for p, _ in priced):
                    continue
            else:
                value = _on_or_before(points, day)
                if value is None:
                    if points:
                        anchor_date, anchor = points[0]
                    elif current is not None:
                        anchor_date, anchor = a.balance_as_of or today, current
                    else:
                        continue
                    ledger = amounts.get(a.id)
                    if a.id in walked and day < anchor_date:
                        # Offset so the walk meets the first balance on record.
                        parts = walked[a.id]
                        shift = abs(anchor) - balance_on(parts, anchor_date, abs(anchor))
                        value = balance_on(parts, day, abs(anchor)) + shift
                    elif ledger is None or day >= anchor_date:
                        value = anchor
                    elif a.account_type in CREDIT_CARD_TYPES:
                        value = max(0.0, -balance_before(anchor_date, -abs(anchor), ledger, day))
                    else:
                        value = balance_before(anchor_date, anchor, ledger, day)
            series.append({"date": day.isoformat(), "balance": round(abs(value) if owed else value, 2)})
        if series:
            out[a.id] = series
    return out

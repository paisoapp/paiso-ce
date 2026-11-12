"""Ordered replay of a holding's trade history.

Replaces the old aggregate-SUM recalc: splits rescale shares multiplicatively
and sells remove basis at the running average cost, so the events must be
applied in chronological order rather than summed.

Replay semantics (average-cost):

    buy       shares += s          basis += s × price
    sell      shares -= s          basis -= s × avg_cost   (floored at 0)
    reinvest  shares += s          basis += amount (fallback s × price)
    dividend / interest / capgain   no share or basis effect (income only)
    split     shares ×= ratio      basis unchanged
"""
from datetime import date

import structlog
from sqlalchemy import func, select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.holding import Holding
from app.models.trade import Trade

log = structlog.get_logger()


def replay_trades(trades: list[Trade]) -> tuple[float, float | None]:
    """Return (net_shares, cost_basis) after replaying trades in order.

    Trades must already be sorted by (trade_date, id).

    ``cost_basis`` is **None when it is not known**, which is different from
    zero. An acquisition carries basis only if it records a price, and nothing
    requires one — so a position entered as "100 shares, no price" produced a
    basis of 0.0, indistinguishable from a genuinely zero-basis gift. The
    holdings table then reported the entire market value as gain: $4,000 of
    "Total G/L" on a position whose cost nobody had recorded.

    Returning None makes the caller say "—" instead of inventing a number.
    Partial knowledge counts as unknown for the same reason: a basis missing
    half its lots is not a smaller basis, it is a wrong one.
    """
    shares = 0.0
    basis = 0.0
    #: Acquisitions seen, and how many of them told us what they cost.
    acquisitions = priced_acquisitions = 0
    for t in trades:
        s = float(t.shares or 0)
        price = float(t.price_per_share) if t.price_per_share is not None else None
        if t.action == "buy":
            shares += s
            acquisitions += 1
            if price is not None:
                basis += s * price
                priced_acquisitions += 1
        elif t.action == "sell":
            avg = basis / shares if shares > 0 else 0.0
            shares -= s
            basis -= s * avg
        elif t.action == "reinvest":
            shares += s
            acquisitions += 1
            if t.amount is not None:
                basis += float(t.amount)
                priced_acquisitions += 1
            elif price is not None:
                basis += s * price
                priced_acquisitions += 1
        elif t.action == "split":
            ratio = float(t.split_ratio or 0)
            if ratio > 0:
                shares *= ratio
        elif t.action == "transfer_in":
            # Shares arriving from another account. Arithmetically a buy; it is
            # a distinct action only because it is not a taxable acquisition.
            shares += s
            acquisitions += 1
            if price is not None:
                basis += s * price
                priced_acquisitions += 1
        elif t.action == "transfer_out":
            avg = basis / shares if shares > 0 else 0.0
            shares -= s
            basis -= s * avg
        # dividend / interest / capgain: cash income, no position effect.
        # fee: cash out, no position effect.
        shares = max(shares, 0.0)
        basis = max(basis, 0.0)

    if acquisitions and priced_acquisitions < acquisitions:
        return shares, None
    return shares, round(basis, 2)


def shares_on_date(trades: list[Trade], as_of: date) -> float:
    """Shares held at end of day `as_of`, from trades sorted by (trade_date, id)."""
    net, _ = replay_trades([t for t in trades if t.trade_date <= as_of])
    return net


OPENING_BALANCE_NOTE = "Opening balance: shares held before the first recorded trade"


async def ensure_opening_trade(holding: Holding, first_trade_date: date, db: AsyncSession) -> None:
    """Record a holding's existing shares as a trade before its first trade.

    A holding with no trades keeps the shares and cost basis that a statement
    import or the edit form wrote. Once it has a trade, `recalc_holding`
    rebuilds both from the trades alone, so the first trade would replace a
    50-share position with that one trade's shares, and later statements would
    leave the holding alone because it is now trade-managed.

    This adds a `transfer_in` for the existing shares, priced at the average
    cost when the basis is known, dated on or before `first_trade_date`. Call it
    before adding the new trade, so the opening trade has the lower id and
    replays first on the same date. It does nothing when the holding already
    has trades or holds no shares.
    """
    shares = float(holding.shares or 0)
    if shares <= 0:
        return
    has_trades = await db.scalar(
        select(func.count()).select_from(Trade).where(Trade.holding_id == holding.id)
    )
    if has_trades:
        return
    basis = holding.cost_basis_total
    opened = holding.acquired_at if holding.acquired_at and holding.acquired_at < first_trade_date \
        else first_trade_date
    db.add(Trade(
        holding_id=holding.id,
        trade_date=opened,
        action="transfer_in",
        shares=shares,
        price_per_share=None if basis is None else round(float(basis) / shares, 6),
        notes=OPENING_BALANCE_NOTE,
    ))
    await db.flush()


async def recalc_holding(holding_id: int, db: AsyncSession) -> None:
    """Recompute shares and cost_basis_total from the full trade history.

    Writes via a direct SQL UPDATE so the result is persisted regardless of
    ORM session state (same contract as the old _recalc_* helpers).
    """
    trades = (await db.scalars(
        select(Trade)
        .where(Trade.holding_id == holding_id)
        .order_by(Trade.trade_date, Trade.id)
    )).all()
    shares, basis = replay_trades(list(trades))
    await db.execute(
        sa_update(Holding)
        .where(Holding.id == holding_id)
        .values(shares=shares, cost_basis_total=basis)
    )

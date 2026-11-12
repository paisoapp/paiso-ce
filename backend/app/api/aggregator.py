"""OFX investment statements, for ``/api/imports/ofx`` in ``app/api/imports.py``.

Two parts of the statement reach the holdings:

* **Positions** (INVPOSLIST) say what the account holds on the statement
  date. :func:`_import_positions` creates a holding for each, or sets the
  shares of one that already exists, and stores the statement's unit price,
  which is the only price a fund with no ticker has.
* **Income** (INCOME and REINVEST rows) becomes income trades, but only on
  holdings the user keeps by trades. On any other holding the shares come
  from the statement, which already counts reinvested shares, and replaying
  one month of trades over it would replace the position with that month.

The routes that lived here (``/api/aggregator/import/csv``, and an OFX import
before it) had no screen calling them, and the CSV one read a file of any size
into memory. They were removed; every import goes through
``app/api/imports.py``.
"""
from dataclasses import dataclass
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.upsert import dialect_insert
from app.models.holding import Holding
from app.models.security import PriceHistory, Security
from app.models.trade import Trade
from app.modules.investments.activity import recalc_holding

#: Position aggregate -> Security.type.
_POSITION_TYPE = {
    "POSSTOCK": "stock",
    "POSMF": "mutual_fund",
    "POSDEBT": "fixed_income",
    "POSOTHER": "other",
}


_INCOME_TYPE_TO_ACTION = {
    "DIV": "dividend",
    "INTEREST": "interest",
    "CGLONG": "capgain",
    "CGSHORT": "capgain",
}


async def _trade_managed(db: AsyncSession, account_id: int) -> set[int]:
    """Holdings in the account whose shares come from their trades."""
    return set((await db.scalars(
        select(Holding.id)
        .join(Trade, Trade.holding_id == Holding.id)
        .where(Holding.account_id == account_id)
        .distinct()
    )).all())


async def _income_holding(db: AsyncSession, inc, account_id: int, by_trades: set[int]) -> Holding | None:
    """The holding an income row belongs to: in the account, matched by
    ticker (the SECID, or the SECLIST's ticker for it) or by CUSIP, and kept
    by trades (see the module docstring). None when there is none."""
    if not inc.uniqueid or inc.total <= 0:
        return None
    tickers = {t for t in (inc.uniqueid.upper(), (inc.ticker or "").upper()) if t}
    holding = await db.scalar(
        select(Holding)
        .join(Security, Security.id == Holding.security_id)
        .where(
            Holding.account_id == account_id,
            or_(Security.ticker.in_(tickers), Security.cusip == inc.uniqueid),
        )
    )
    return holding if holding is not None and holding.id in by_trades else None


async def _income_to_record(inv_income, account_id: int, db: AsyncSession) -> int:
    """How many of the statement's income rows an import would record: those
    with a holding kept by trades, not recorded before. For the preview."""
    by_trades = await _trade_managed(db, account_id)
    count = 0
    for inc in inv_income:
        holding = await _income_holding(db, inc, account_id, by_trades)
        if holding is None:
            continue
        if not await db.scalar(select(Trade.id).where(
            Trade.holding_id == holding.id, Trade.external_id == inc.fitid,
        )):
            count += 1
    return count


async def _import_inv_income(inv_income, account_id: int, db: AsyncSession) -> tuple[int, int]:
    """Map structured OFX INCOME/REINVEST rows onto holdings as income trades.

    Matches a holding in the import account by ticker (the SECID, or the
    SECLIST's ticker for it) or by CUSIP, and only a holding the user keeps
    by trades (see the module docstring). Dedupes on Trade.external_id ==
    FITID.
    """
    recorded = skipped = 0
    touched: set[int] = set()
    by_trades = await _trade_managed(db, account_id)
    for inc in inv_income:
        holding = await _income_holding(db, inc, account_id, by_trades)
        if holding is None:
            skipped += 1
            continue
        dup = await db.scalar(
            select(Trade.id).where(
                Trade.holding_id == holding.id,
                Trade.external_id == inc.fitid,
            )
        )
        if dup:
            skipped += 1
            continue

        action = "reinvest" if inc.is_reinvest else _INCOME_TYPE_TO_ACTION.get(inc.income_type, "dividend")
        db.add(Trade(
            holding_id=holding.id,
            trade_date=inc.date_posted,
            action=action,
            shares=inc.units if inc.is_reinvest else 0,
            price_per_share=inc.unit_price if inc.is_reinvest and inc.unit_price else None,
            amount=inc.total,
            is_qualified=(action in ("dividend", "reinvest")) or None,
            external_id=inc.fitid,
            notes=inc.memo or None,
        ))
        touched.add(holding.id)
        recorded += 1

    if touched:
        await db.flush()
        for hid in touched:
            await recalc_holding(hid, db)
    return recorded, skipped


@dataclass
class PositionsResult:
    created: int = 0
    updated: int = 0
    #: Positions on holdings the user keeps by trades, left as they are.
    kept: int = 0


async def _resolve_security(db: AsyncSession, position) -> Security:
    """The Security a statement position is in: found by CUSIP, then by
    ticker, else created. Fills in a ticker or CUSIP the row is missing when
    no other security already has it."""
    cusip = position.uniqueid if position.uniqueid_type == "CUSIP" and position.uniqueid else None
    ticker = position.ticker or None
    sec = await db.scalar(select(Security).where(Security.cusip == cusip)) if cusip else None
    if sec is None and ticker:
        sec = await db.scalar(select(Security).where(Security.ticker == ticker))
    if sec is None:
        sec = Security(
            ticker=ticker,
            cusip=cusip,
            name=(position.name or ticker or f"Security {position.uniqueid}")[:255],
            type=_POSITION_TYPE.get(position.kind, "other"),
        )
        db.add(sec)
        await db.flush()
        return sec
    if ticker and not sec.ticker and not await db.scalar(select(Security.id).where(Security.ticker == ticker)):
        sec.ticker = ticker
    if cusip and not sec.cusip and not await db.scalar(select(Security.id).where(Security.cusip == cusip)):
        sec.cusip = cusip
    return sec


async def _import_positions(positions, account_id: int, db: AsyncSession,
                            statement_date: date) -> PositionsResult:
    """Create or update a holding for each statement position.

    A holding the user keeps by trades is left alone: its shares are the
    replay of those trades, and the statement would fight them. Short and
    zero positions are skipped. Cost basis is left as it is: positions do not
    carry it.
    """
    result = PositionsResult()
    by_trades = await _trade_managed(db, account_id)
    for pos in positions:
        if pos.units <= 0 or not (pos.uniqueid or pos.ticker):
            continue
        sec = await _resolve_security(db, pos)
        holding = await db.scalar(
            select(Holding).where(Holding.account_id == account_id, Holding.security_id == sec.id)
        )
        if holding is not None and holding.id in by_trades:
            result.kept += 1
        elif holding is not None:
            if float(holding.shares or 0) != pos.units:
                holding.shares = pos.units
                result.updated += 1
        else:
            db.add(Holding(account_id=account_id, security_id=sec.id, shares=pos.units))
            result.created += 1

        # The statement's price, for the day it was priced. A close the market
        # data already stored for that day wins; for a fund with no ticker this
        # is the only price there is.
        if pos.unit_price > 0:
            await db.execute(
                dialect_insert(PriceHistory)
                .values(security_id=sec.id, as_of=pos.price_as_of or statement_date,
                        close=pos.unit_price)
                .on_conflict_do_nothing(index_elements=["security_id", "as_of"])
            )
    await db.flush()
    return result

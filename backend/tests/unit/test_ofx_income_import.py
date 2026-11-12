"""Unit tests for mapping parsed OFX INCOME/REINVEST rows onto holdings as
income trades (ticker matching, FITID dedupe, recalc side effects)."""
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.api.aggregator import _import_inv_income
from app.models.holding import Holding
from app.models.security import Security
from app.models.trade import Trade
from app.modules.aggregator.ofx_parser import ParsedInvIncome

pytestmark = pytest.mark.unit


def _income(fitid, uniqueid, total, *, reinvest=False, units=0.0, price=0.0,
            income_type="DIV", day=15):
    return ParsedInvIncome(
        fitid=fitid, date_posted=date(2024, 1, day), uniqueid=uniqueid,
        income_type=income_type, total=total, is_reinvest=reinvest,
        units=units, unit_price=price,
    )


async def _setup():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    db = AsyncSession(engine, expire_on_commit=False)
    sec = Security(ticker="VTI", name="Total Market", type="etf")
    db.add(sec)
    await db.flush()
    holding = Holding(account_id=1, security_id=sec.id, shares=10, cost_basis_total=1000)
    db.add(holding)
    await db.flush()
    # seed a buy so recalc has history
    db.add(Trade(holding_id=holding.id, trade_date=date(2024, 1, 1),
                 action="buy", shares=10, price_per_share=100))
    await db.flush()
    return engine, db, holding


async def test_import_records_and_dedupes():
    engine, db, holding = await _setup()

    rows = [
        _income("F-1", "VTI", 25.0),
        _income("F-2", "VTI", 30.0, reinvest=True, units=0.25, price=120.0),
        _income("F-3", "UNKNOWN", 10.0),      # no matching holding
        _income("F-4", "VTI", 5.0, income_type="INTEREST"),
    ]
    recorded, skipped = await _import_inv_income(rows, account_id=1, db=db)
    assert recorded == 3
    assert skipped == 1

    trades = (await db.scalars(
        select(Trade).where(Trade.holding_id == holding.id).order_by(Trade.id)
    )).all()
    actions = [t.action for t in trades]
    assert actions == ["buy", "dividend", "reinvest", "interest"]
    assert float(trades[2].shares) == pytest.approx(0.25)

    # Recalc ran: reinvest added shares + basis
    h = await db.get(Holding, holding.id)
    assert float(h.shares) == pytest.approx(10.25)
    assert float(h.cost_basis_total) == pytest.approx(1030.0)

    # Re-import the same rows → all deduped on FITID
    recorded2, skipped2 = await _import_inv_income(rows, account_id=1, db=db)
    assert recorded2 == 0
    assert skipped2 == 4

    await db.close(); await engine.dispose()

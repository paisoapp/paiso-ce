"""Daily closes are dated by the market's session, not the server's UTC clock.

Regression cover: after 7pm Central the UTC date is already tomorrow,
and an off-hours POST /market/refresh stored the day's close under that date.
The day change then compared the close with itself and every row read $0.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.security import PriceHistory, Security
from app.modules.investments import refresh as refresh_mod
from app.modules.investments.market_data import _et_date
from app.modules.investments.refresh import (
    _quote_session, market_today, prune_stray_closes, trades_weekends,
)

pytestmark = pytest.mark.unit

MON = date(2026, 10, 19)


def test_market_today_is_eastern_after_utc_midnight():
    # 04:07 UTC Tuesday is 00:07 ET Tuesday; 03:00 UTC Tuesday is still Monday ET.
    assert market_today(datetime(2026, 10, 20, 3, 0, tzinfo=timezone.utc)) == MON
    assert market_today(datetime(2026, 10, 20, 4, 7, tzinfo=timezone.utc)) == MON + timedelta(days=1)


def test_regular_market_time_maps_to_eastern_date():
    # 4:00pm ET Monday close, read back at any hour.
    close = datetime(2026, 10, 19, 20, 0, tzinfo=timezone.utc).timestamp()
    assert _et_date(close) == "2026-10-19"
    assert _et_date(None) is None


def test_quote_session_uses_the_quote_date():
    assert _quote_session({"market_date": "2026-10-19"}, MON + timedelta(days=1), False) == MON


def test_quote_session_never_claims_a_future_date():
    q = {"market_date": "2026-10-21"}
    assert _quote_session(q, MON, True) == MON


def test_quote_session_without_a_date_writes_nothing_while_closed(monkeypatch):
    monkeypatch.setattr(refresh_mod, "is_market_open", lambda: False)
    assert _quote_session({}, MON, False) is None
    assert _quote_session({}, MON, True) == MON   # crypto always has a session


def test_trades_weekends():
    assert trades_weekends("DOGE-USD")
    assert trades_weekends("BTC", "crypto")
    assert not trades_weekends("HOOD", "stock")


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield session
    finally:
        await engine.dispose()


async def test_prune_drops_future_and_weekend_rows(db):
    stock = Security(ticker="HOOD", name="HOOD", type="stock")
    coin = Security(ticker="DOGE-USD", name="DOGE", type="crypto")
    db.add_all([stock, coin])
    await db.commit()
    today = market_today()
    sat = today - timedelta(days=(today.weekday() - 5) % 7)   # most recent Saturday
    rows = [
        (stock.id, today + timedelta(days=1)),   # tomorrow: stray
        (stock.id, sat),                         # weekend stock close: stray
        (stock.id, sat - timedelta(days=1)),     # Friday: real
        (coin.id, sat),                          # crypto trades Saturdays: real
    ]
    db.add_all([PriceHistory(security_id=s, as_of=d, close=1.0) for s, d in rows])
    await db.commit()

    pruned = await prune_stray_closes(db, [stock, coin])
    await db.commit()

    left = set((await db.execute(select(PriceHistory.security_id, PriceHistory.as_of))).all())
    assert pruned == 2
    assert left == {(stock.id, sat - timedelta(days=1)), (coin.id, sat)}

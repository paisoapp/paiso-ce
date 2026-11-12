"""a "Today" net-worth chart draws the latest session, not one dot.

Priced holdings move bar by bar; everything else (cash, debts, excluded
holdings) is one flat amount, and the line ends at today's net worth.
"""
from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.portfolio import net_worth_intraday
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import IntradayPriceHistory, PriceHistory, Security
from app.models.user import User
from app.modules.portfolio import positions
from app.modules.portfolio.summary import get_portfolio_summary


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


@pytest.fixture(autouse=True)
def quotes(monkeypatch):
    prices = {"VTI": 310.0, "ACME": 50.0}
    monkeypatch.setattr(positions, "get_quotes_cached",
                        lambda ts: {t: {"price": prices.get(t, 0.0)} for t in ts})


def _last_weekday_before_today() -> date:
    d = date.today() - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


async def test_today_is_the_session_plus_what_does_not_move(db):
    user = User(email="nw@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    brokerage = Account(user_id=user.id, display_name="Brokerage", account_type="brokerage")
    checking = Account(user_id=user.id, display_name="Checking", account_type="checking",
                       current_balance=Decimal("2000"))
    card = Account(user_id=user.id, display_name="Card", account_type="credit_card",
                   current_balance=Decimal("500"))
    vti = Security(ticker="VTI", name="VTI", type="etf")
    acme = Security(ticker="ACME", name="ACME", type="stock")
    db.add_all([brokerage, checking, card, vti, acme])
    await db.flush()
    db.add_all([
        Holding(account_id=brokerage.id, security_id=vti.id, shares=Decimal("10")),
        # Excluded from net worth: no part of the line, moving or flat.
        Holding(account_id=brokerage.id, security_id=acme.id, shares=Decimal("100"),
                exclude_from_net_worth=True),
    ])
    session = _last_weekday_before_today()
    db.add(PriceHistory(security_id=vti.id, as_of=session - timedelta(days=1), close=Decimal("300")))
    # 10:00 and 11:00 ET, as naive UTC (14:00/15:00 in summer, 15:00/16:00 in winter).
    for hour, close in ((15, Decimal("305")), (16, Decimal("308"))):
        db.add(IntradayPriceHistory(security_id=vti.id, interval="1m",
                                    ts=datetime(session.year, session.month, session.day, hour, 0), close=close))
    await db.commit()

    summary = await get_portfolio_summary(user.id, db)
    out = await net_worth_intraday(db=db, user=user,
                                   user_acct_ids=[brokerage.id, checking.id, card.id])
    series = out["series"]
    assert out["session"]["date"] == session.isoformat()
    assert len(series) >= 3  # the previous close at the open, then each bar
    # The line ends at today's net worth, and moves only with VTI.
    assert series[-1]["net_worth"] == pytest.approx(summary["net_worth"])
    assert series[-1]["net_worth"] - series[0]["net_worth"] == pytest.approx(10 * (308 - 300))
    assert all(p["total_liabilities"] == pytest.approx(summary["total_liabilities"]) for p in series)
    for p in series:
        assert p["total_assets"] - p["total_liabilities"] == pytest.approx(p["net_worth"])


async def test_no_priced_holdings_means_no_intraday_line(db):
    user = User(email="nw2@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    checking = Account(user_id=user.id, display_name="Checking", account_type="checking",
                       current_balance=Decimal("2000"))
    db.add(checking)
    await db.commit()
    out = await net_worth_intraday(db=db, user=user, user_acct_ids=[checking.id])
    assert out["series"] == []

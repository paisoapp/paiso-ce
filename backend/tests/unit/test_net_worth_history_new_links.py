"""Net-worth history for data Paiso has only just been given.

A brand-new user linked a 401(k) and the trend left it out of every day
before its funds' first stored close, so three months read as one large gain
landing in the last few days. A mortgage linked the same way started from its
original amount.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401
from app.core.database import Base
from app.models.account import Account
from app.models.asset import Asset, Loan
from app.models.holding import Holding
from app.models.security import PriceHistory, Security
from app.models.user import User
from app.modules.portfolio.net_worth_history import reconstruct_net_worth

pytestmark = pytest.mark.unit

TODAY = date.today()
START = TODAY - timedelta(days=90)


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


@pytest.fixture
async def user(db):
    u = User(email="new@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.commit()
    return u


async def test_a_fund_priced_only_since_the_link_is_carried_back_flat(db, user):
    acct = Account(user_id=user.id, display_name="401(k)", account_type="401k",
                   current_balance=Decimal("60000"))
    vti = Security(ticker="VTI", name="Vanguard Total Stock Market", type="etf")
    db.add_all([acct, vti])
    await db.flush()
    db.add(Holding(account_id=acct.id, security_id=vti.id, shares=Decimal("250")))
    # Closes fetched from the link date, three days ago.
    for back, close in ((3, "290"), (2, "291"), (1, "292"), (0, "292")):
        db.add(PriceHistory(security_id=vti.id, as_of=TODAY - timedelta(days=back),
                            close=Decimal(close)))
    await db.commit()

    series = await reconstruct_net_worth(db, user.id, START, TODAY)
    first, last = series[0], series[-1]
    assert first["investments"] == pytest.approx(250 * 290)  # not $0
    assert last["investments"] == pytest.approx(250 * 292)
    # No jump: the oldest day and the link day are within the price move.
    assert last["net_worth"] - first["net_worth"] == pytest.approx(250 * 2)


async def test_a_linked_mortgage_works_back_from_its_balance_not_its_original_amount(db, user):
    home = Asset(user_id=user.id, category="primary_home", name="Home",
                 current_value=Decimal("500000"))
    db.add(home)
    await db.flush()
    # A 30-year $400K loan from 2019; the bank says $350K is owed today.
    db.add(Loan(asset_id=home.id, principal=Decimal("400000"), rate_apr=Decimal("3.5"),
                term_months=360, origination=date(2019, 6, 1),
                balance_override=Decimal("350000"), balance_override_date=TODAY))
    await db.commit()

    series = await reconstruct_net_worth(db, user.id, START, TODAY)
    first, last = series[0], series[-1]
    assert last["mortgages"] == pytest.approx(350000, abs=1)
    # Three months earlier a little more was owed, not the original $400K.
    assert 350000 < first["mortgages"] < 354000
    days = [p["mortgages"] for p in series]
    assert all(a >= b for a, b in zip(days, days[1:])), "owed only falls, with no jump"

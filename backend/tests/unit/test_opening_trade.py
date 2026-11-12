"""Shares a holding had before its first trade survive that trade.

A statement import or the edit form writes `Holding.shares` directly. Once a
holding has a trade, `recalc_holding` rebuilds the shares from trades alone,
so `ensure_opening_trade` records the earlier shares as a `transfer_in` first.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api import holdings as holdings_api
from app.api import investment_income as income_api
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
from app.models.trade import Trade
from app.models.user import User
from app.modules.investments.activity import OPENING_BALANCE_NOTE

pytestmark = pytest.mark.unit


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


async def _ctx(db, shares, basis, acquired_at=None):
    user = User(email="o@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    account = Account(user_id=user.id, account_type="brokerage",
                      display_name="Vanguard", currency="USD")
    security = Security(ticker="VTI", name="Vanguard Total Stock Market ETF", type="etf")
    db.add_all([account, security])
    await db.flush()
    holding = Holding(account_id=account.id, security_id=security.id,
                      shares=None if shares is None else Decimal(str(shares)),
                      cost_basis_total=None if basis is None else Decimal(str(basis)),
                      acquired_at=acquired_at)
    db.add(holding)
    await db.commit()
    return user, account, holding


async def _buy(db, user, account, holding, shares, price, on=date(2026, 9, 1), action="buy"):
    return await holdings_api.create_trade(
        holding_id=holding.id,
        body=holdings_api.TradeCreate(trade_date=on, action=action,
                                      shares=shares, price_per_share=price),
        db=db, user=user, user_acct_ids=[account.id],
    )


async def _state(db, holding):
    refreshed = await db.get(Holding, holding.id)
    await db.refresh(refreshed)
    trades = (await db.scalars(
        select(Trade).where(Trade.holding_id == holding.id).order_by(Trade.trade_date, Trade.id)
    )).all()
    return refreshed, trades


async def test_a_buy_adds_to_statement_shares(db):
    """50 shares from a statement plus a buy of 5 is 55, not 5."""
    user, account, holding = await _ctx(db, shares=50, basis=10000)
    await _buy(db, user, account, holding, 5, 250)

    refreshed, trades = await _state(db, holding)
    assert float(refreshed.shares) == pytest.approx(55)
    assert float(refreshed.cost_basis_total) == pytest.approx(11250)
    opening = trades[0]
    assert opening.action == "transfer_in"
    assert float(opening.shares) == pytest.approx(50)
    assert float(opening.price_per_share) == pytest.approx(200)
    assert opening.notes == OPENING_BALANCE_NOTE


async def test_an_unknown_basis_stays_unknown(db):
    user, account, holding = await _ctx(db, shares=50, basis=None)
    await _buy(db, user, account, holding, 5, 250)

    refreshed, trades = await _state(db, holding)
    assert float(refreshed.shares) == pytest.approx(55)
    assert refreshed.cost_basis_total is None
    assert trades[0].price_per_share is None


async def test_a_same_day_sell_comes_out_of_the_opening_shares(db):
    user, account, holding = await _ctx(db, shares=50, basis=10000)
    await _buy(db, user, account, holding, 20, 260, action="sell")

    refreshed, trades = await _state(db, holding)
    assert [t.action for t in trades] == ["transfer_in", "sell"]
    assert float(refreshed.shares) == pytest.approx(30)
    assert float(refreshed.cost_basis_total) == pytest.approx(6000)


async def test_the_opening_trade_takes_an_earlier_acquired_date(db):
    user, account, holding = await _ctx(db, shares=50, basis=10000,
                                        acquired_at=date(2020, 3, 2))
    await _buy(db, user, account, holding, 5, 250)

    _, trades = await _state(db, holding)
    assert trades[0].trade_date == date(2020, 3, 2)


async def test_a_later_acquired_date_does_not_move_the_opening_after_the_trade(db):
    user, account, holding = await _ctx(db, shares=50, basis=10000,
                                        acquired_at=date(2026, 10, 1))
    await _buy(db, user, account, holding, 5, 250, on=date(2026, 9, 1))

    _, trades = await _state(db, holding)
    assert trades[0].trade_date == date(2026, 9, 1)
    assert trades[0].action == "transfer_in"


async def test_only_the_first_trade_adds_an_opening(db):
    user, account, holding = await _ctx(db, shares=50, basis=10000)
    await _buy(db, user, account, holding, 5, 250)
    await _buy(db, user, account, holding, 5, 250, on=date(2026, 9, 2))

    refreshed, trades = await _state(db, holding)
    assert [t.action for t in trades] == ["transfer_in", "buy", "buy"]
    assert float(refreshed.shares) == pytest.approx(60)


async def test_a_holding_without_shares_gets_no_opening(db):
    """The Add holding drawer creates an empty holding, then its trades."""
    user, account, holding = await _ctx(db, shares=None, basis=None)
    await _buy(db, user, account, holding, 5, 250)

    refreshed, trades = await _state(db, holding)
    assert [t.action for t in trades] == ["buy"]
    assert float(refreshed.shares) == pytest.approx(5)


async def test_a_confirmed_dividend_keeps_statement_shares(db):
    """A dividend has no shares of its own, so without the opening it zeroed the holding."""
    user, account, holding = await _ctx(db, shares=50, basis=10000)
    await income_api.confirm_dividend_suggestions(
        holding_id=holding.id,
        body=income_api.SuggestionConfirmBody(confirmations=[
            income_api.SuggestionConfirm(ex_date=date(2026, 9, 25), amount=Decimal("41.20")),
            income_api.SuggestionConfirm(ex_date=date(2026, 6, 25), amount=Decimal("40.10")),
        ]),
        db=db, user=user, user_acct_ids=[account.id],
    )

    refreshed, trades = await _state(db, holding)
    assert float(refreshed.shares) == pytest.approx(50)
    assert float(refreshed.cost_basis_total) == pytest.approx(10000)
    assert trades[0].action == "transfer_in"
    assert trades[0].trade_date == date(2026, 6, 25)

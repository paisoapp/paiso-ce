"""Investment activity across holdings.

A brokerage's dividends and reinvestments are trades on a holding. The Transactions page only read the cash ledger, so its
Investments tab stayed empty. This is the list that tab now shows.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.investment_activity import investment_activity
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
from app.models.trade import Trade
from app.models.user import User

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


async def _portfolio(db, email="a@example.com"):
    """A Vanguard account's reinvested dividend as its statement shows it: a
    dividend row (with Vanguard's placeholder price of 1.00) and a buy beside
    it."""
    user = User(email=email, hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    account = Account(user_id=user.id, account_type="brokerage",
                      display_name="Vanguard Brokerage", currency="USD")
    ticker = "NVDA" if email.startswith("a@") else "MSFT"
    security = Security(ticker=ticker, name=f"{ticker} Corp", type="stock")
    db.add_all([account, security])
    await db.flush()
    holding = Holding(account_id=account.id, security_id=security.id, shares=Decimal("100"))
    db.add(holding)
    await db.flush()
    db.add_all([
        Trade(holding_id=holding.id, trade_date=date(2026, 6, 26), action="dividend",
              shares=0, price_per_share=Decimal("1"), amount=Decimal("500"), external_id="d1"),
        Trade(holding_id=holding.id, trade_date=date(2026, 6, 26), action="buy",
              shares=Decimal("2.5"), price_per_share=Decimal("200"), external_id="b1"),
        Trade(holding_id=holding.id, trade_date=date(2026, 10, 1), action="dividend",
              shares=0, price_per_share=Decimal("1"), amount=Decimal("600"), external_id="d2"),
        Trade(holding_id=holding.id, trade_date=date(2026, 10, 1), action="buy",
              shares=Decimal("2.4"), price_per_share=Decimal("250"), external_id="b2"),
        Trade(holding_id=holding.id, trade_date=date(2026, 9, 1), action="fee",
              shares=0, amount=Decimal("5")),
    ])
    await db.commit()
    return user, account, holding


async def _activity(db, user, account_ids, **kw):
    params = dict(date_from=None, date_to=None, account_id=None, kind=None, search=None,
                  page=1, page_size=20)
    params.update(kw)
    return await investment_activity(db=db, user=user, user_acct_ids=account_ids, **params)


async def test_a_reinvested_dividend_shows_as_its_two_rows_newest_first(db):
    user, account, _ = await _portfolio(db)
    out = await _activity(db, user, [account.id])

    assert out["total"] == 5
    assert [(i["trade_date"], i["action"]) for i in out["items"][:2]] == [
        ("2026-10-01", "buy"), ("2026-10-01", "dividend"),
    ]
    buy = out["items"][0]
    assert buy["ticker"] == "NVDA" and buy["account_name"] == "Vanguard Brokerage"
    assert buy["shares"] == pytest.approx(2.4) and buy["price_per_share"] == 250
    assert buy["total"] == pytest.approx(600.0) and buy["is_income"] is False
    # The dividend is counted once, as income. The buy beside it is not income.
    assert out["income_total"] == 1100.0


async def test_a_dividend_has_no_shares_and_no_price(db):
    """Vanguard sends a price of 1.00 with a dividend. It is not a share price."""
    user, account, _ = await _portfolio(db)
    out = await _activity(db, user, [account.id], kind="income")

    assert out["total"] == 2
    for item in out["items"]:
        assert item["shares"] is None and item["price_per_share"] is None
        assert item["is_income"] is True
    assert out["items"][0]["total"] == 600.0


async def test_filters_narrow_the_list_and_the_income_total_together(db):
    user, account, _ = await _portfolio(db)

    autumn = await _activity(db, user, [account.id], date_from=date(2026, 9, 1))
    assert autumn["total"] == 3 and autumn["income_total"] == 600.0

    trades = await _activity(db, user, [account.id], kind="trades")
    assert {i["action"] for i in trades["items"]} == {"buy"} and trades["income_total"] == 0

    other = await _activity(db, user, [account.id], kind="other")
    assert [i["action"] for i in other["items"]] == ["fee"]
    assert other["items"][0]["total"] == 5.0

    assert (await _activity(db, user, [account.id], search="nvd"))["total"] == 5
    assert (await _activity(db, user, [account.id], search="tsla"))["total"] == 0

    paged = await _activity(db, user, [account.id], page=2, page_size=2)
    assert paged["total"] == 5 and len(paged["items"]) == 2


async def test_another_users_activity_is_never_listed(db):
    user, account, _ = await _portfolio(db)
    _, other_account, _ = await _portfolio(db, email="b@example.com")

    mine = await _activity(db, user, [account.id])
    assert {i["ticker"] for i in mine["items"]} == {"NVDA"}
    # Asking for their account by id gets nothing, not their rows.
    theirs = await _activity(db, user, [account.id], account_id=other_account.id)
    assert theirs["items"] == [] and theirs["total"] == 0
    assert (await _activity(db, user, []))["total"] == 0

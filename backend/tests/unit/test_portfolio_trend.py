"""The portfolio value series over time.

The property that matters: a point on this chart is the value of the *whole*
portfolio on that date. Securities do not share a price calendar — yfinance
writes weekdays only, a price from an imported statement lands on whatever
day it was observed — so summing "whatever had a row that day"
answers a different question, and answers it wrongly.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api import portfolio_trend
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import PriceHistory, Security
from app.models.user import User

pytestmark = pytest.mark.unit

MONDAY = date(2026, 2, 2)


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


async def _ctx(db):
    user = User(email="t@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    account = Account(user_id=user.id, account_type="brokerage",
                      display_name="Brokerage", currency="USD")
    db.add(account)
    await db.flush()
    return user, account


async def _hold(db, account, ticker, shares, name=None):
    security = Security(ticker=ticker, name=name or ticker, type="stock")
    db.add(security)
    await db.flush()
    holding = Holding(account_id=account.id, security_id=security.id,
                      shares=Decimal(str(shares)))
    db.add(holding)
    await db.flush()
    return security


async def _price(db, security, day, close):
    db.add(PriceHistory(security_id=security.id, as_of=day,
                        close=Decimal(str(close))))


async def _series(db, user, account, **kw):
    out = await portfolio_trend.portfolio_trend(
        days=kw.pop("days", 365), interval="1d", account_id=None,
        security_ids=None, breakdown=kw.pop("breakdown", False),
        date_from=None, date_to=None, db=db, user=user,
        user_acct_ids=[account.id],
    )
    return out


async def test_a_day_only_one_security_was_priced_on_does_not_collapse(db):
    """The bug this guards against.

    A big position priced on weekdays, and a small one that also carries a
    weekend mark. On Saturday only the small one had a row, so the total was
    *its* value alone — the chart fell from the portfolio's real worth to $18
    and back, once a week, across a year of history.
    """
    user, account = await _ctx(db)
    big = await _hold(db, account, "ACME", 1000)
    small = await _hold(db, account, "CASHX", 18)

    friday, saturday = MONDAY + timedelta(days=4), MONDAY + timedelta(days=5)
    await _price(db, big, friday, 40.00)
    await _price(db, small, friday, 1)
    await _price(db, small, saturday, 1)   # only this one has a weekend mark
    await db.commit()

    out = await _series(db, user, account)
    by_date = {p["date"]: p["value"] for p in out["series"]}

    friday_value = 1000 * 40.00 + 18
    assert by_date[friday.isoformat()] == pytest.approx(friday_value, abs=0.01)
    # Saturday carries Friday's close forward rather than forgetting the
    # position exists.
    assert by_date[saturday.isoformat()] == pytest.approx(friday_value, abs=0.01)


async def test_a_stale_price_is_carried_not_dropped(db):
    """A security that stopped being priced keeps its last known value; it did
    not become worthless because the provider went quiet."""
    user, account = await _ctx(db)
    security = await _hold(db, account, "AMZN", 10)
    await _price(db, security, MONDAY, 200)
    other = await _hold(db, account, "MSFT", 1)
    for offset in range(4):
        await _price(db, other, MONDAY + timedelta(days=offset), 10)
    await db.commit()

    out = await _series(db, user, account)
    by_date = {p["date"]: p["value"] for p in out["series"]}
    last = (MONDAY + timedelta(days=3)).isoformat()
    assert by_date[last] == pytest.approx(10 * 200 + 10, abs=0.01)


async def test_a_security_contributes_nothing_before_its_first_close(db):
    """Carrying forward must not become carrying *backward*: a position bought
    later did not have that value in the weeks before it existed."""
    user, account = await _ctx(db)
    early = await _hold(db, account, "AMZN", 10)
    late = await _hold(db, account, "ACME", 100)
    await _price(db, early, MONDAY, 200)
    await _price(db, early, MONDAY + timedelta(days=1), 200)
    await _price(db, late, MONDAY + timedelta(days=1), 25)
    await db.commit()

    out = await _series(db, user, account)
    by_date = {p["date"]: p["value"] for p in out["series"]}
    assert by_date[MONDAY.isoformat()] == pytest.approx(2000, abs=0.01)
    assert by_date[(MONDAY + timedelta(days=1)).isoformat()] == pytest.approx(
        2000 + 2500, abs=0.01
    )


async def test_the_breakdown_matches_the_total(db):
    """The per-ticker series is what the total is made of, so it has to be
    filled the same way or the two disagree on every carried date."""
    user, account = await _ctx(db)
    big = await _hold(db, account, "ACME", 100)
    small = await _hold(db, account, "CASHX", 1)
    friday, saturday = MONDAY + timedelta(days=4), MONDAY + timedelta(days=5)
    await _price(db, big, friday, 25)
    await _price(db, small, friday, 1)
    await _price(db, small, saturday, 1)
    await db.commit()

    out = await _series(db, user, account, breakdown=True)
    acme = {p["date"]: p["close"] for p in out["by_ticker"]["ACME"]}
    assert acme[saturday.isoformat()] == pytest.approx(25)


async def test_the_series_does_not_open_on_a_barely_priced_date(db):
    """"This year" started on New Year's Day, which the market was shut for.

    One security carried an institution mark that day; the twenty market-priced
    ones only started on the 2nd. The series opened at that single position's
    value, jumped vertically to the real total, and the period change read
    as a gain of many thousand percent. A date that prices a twentieth of the portfolio is a gap in
    price history, not a portfolio worth a twentieth of its value.
    """
    user, account = await _ctx(db)
    odd = await _hold(db, account, "CASHX", 24)
    majors = [await _hold(db, account, f"T{i}", 100) for i in range(6)]

    holiday, first_session = MONDAY, MONDAY + timedelta(days=1)
    await _price(db, odd, holiday, 1)
    await _price(db, odd, first_session, 1)
    for security in majors:
        await _price(db, security, first_session, 50)
    await db.commit()

    out = await _series(db, user, account)
    dates = [p["date"] for p in out["series"]]

    assert holiday.isoformat() not in dates
    assert dates[0] == first_session.isoformat()
    assert out["series"][0]["value"] == pytest.approx(24 + 6 * 100 * 50, abs=0.01)


async def test_a_date_missing_one_security_of_many_is_still_kept(db):
    """The trim is for a near-empty date, not for ordinary incompleteness: a
    position bought part-way through the window must not erase the weeks
    before it."""
    user, account = await _ctx(db)
    held = [await _hold(db, account, f"T{i}", 10) for i in range(5)]
    late = await _hold(db, account, "NEW", 10)

    for offset in range(3):
        day = MONDAY + timedelta(days=offset)
        for security in held:
            await _price(db, security, day, 20)
    await _price(db, late, MONDAY + timedelta(days=2), 20)
    await db.commit()

    out = await _series(db, user, account)
    by_date = {p["date"]: p["value"] for p in out["series"]}
    assert by_date[MONDAY.isoformat()] == pytest.approx(5 * 10 * 20, abs=0.01)
    assert by_date[(MONDAY + timedelta(days=2)).isoformat()] == pytest.approx(
        6 * 10 * 20, abs=0.01
    )


async def test_a_tab_charts_only_its_own_accounts(db):
    """Stocks & Funds charts its accounts, not the same ticker in a 401(k)."""
    user, brokerage = await _ctx(db)
    k401 = Account(user_id=user.id, account_type="401k", display_name="401(k)", currency="USD")
    db.add(k401)
    await db.flush()
    vti = await _hold(db, brokerage, "VTI", 10)
    db.add(Holding(account_id=k401.id, security_id=vti.id, shares=Decimal("90")))
    await _price(db, vti, MONDAY, 300)
    await db.commit()

    async def total(account_ids):
        out = await portfolio_trend.portfolio_trend(
            days=3650, interval="1d", account_id=None, account_ids=account_ids,
            security_ids=None, breakdown=False, date_from=MONDAY.isoformat(),
            date_to=MONDAY.isoformat(), db=db, user=user,
            user_acct_ids=[brokerage.id, k401.id],
        )
        return out["series"][-1]["value"] if out["series"] else None

    assert await total(None) == pytest.approx(30_000)
    assert await total(str(brokerage.id)) == pytest.approx(3_000)


async def test_a_plan_tab_line_counts_plans_with_no_priced_positions(db):
    """Retirement: a 401(k) of VTI and an IRA kept as a value. The line is
    both, and either can be overlaid on its own."""
    user, k401 = await _ctx(db)
    k401.account_type = "401k"
    ira = Account(user_id=user.id, account_type="ira", display_name="IRA", currency="USD", other_funds_value=Decimal("5000"))
    db.add(ira)
    await db.flush()
    vti = await _hold(db, k401, "VTI", 10)
    await _price(db, vti, MONDAY, 300)
    await db.commit()

    out = await portfolio_trend.portfolio_trend(
        days=3650, interval="1d", account_id=None, account_ids=f"{k401.id},{ira.id}",
        security_ids=None, breakdown=True, plans=True, overlay_accounts=str(ira.id),
        date_from=MONDAY.isoformat(), date_to=MONDAY.isoformat(), db=db, user=user,
        user_acct_ids=[k401.id, ira.id],
    )
    assert out["series"][-1]["value"] == pytest.approx(3_000 + 5_000)
    assert out["by_ticker"][f"acct:{ira.id}"][-1]["close"] == pytest.approx(5_000)
    # Plans compare against plans; the tickers inside them are not offered.
    assert "VTI" not in out["by_ticker"]


async def test_an_excluded_plan_is_still_in_the_tab_line(db):
    """Excluding a plan from net worth changes nothing on
    its Investments tab. It stays in the tab's line, and charts on its own."""
    user, k401 = await _ctx(db)
    k401.account_type = "401k"
    ira = Account(user_id=user.id, account_type="ira", display_name="IRA", currency="USD", other_funds_value=Decimal("5000"), exclude_from_net_worth=True)
    db.add(ira)
    await db.flush()
    vti = await _hold(db, k401, "VTI", 10)
    await _price(db, vti, MONDAY, 300)
    await db.commit()

    async def last(account_ids):
        out = await portfolio_trend.portfolio_trend(
            days=3650, interval="1d", account_id=None, account_ids=account_ids,
            security_ids=None, breakdown=False, plans=True, overlay_accounts=None,
            date_from=MONDAY.isoformat(), date_to=MONDAY.isoformat(), db=db, user=user,
            user_acct_ids=[k401.id, ira.id],
        )
        return out["series"][-1]["value"] if out["series"] else None

    assert await last(f"{k401.id},{ira.id}") == pytest.approx(3_000 + 5_000)
    assert await last(str(ira.id)) == pytest.approx(5_000)


async def test_an_excluded_holding_is_still_in_the_stocks_line(db):
    """on Stocks & Funds a holding excluded from net worth, or one in an
    excluded account, still counts toward the Performance line."""
    user, brokerage = await _ctx(db)
    other = Account(user_id=user.id, account_type="brokerage", display_name="Other", currency="USD", exclude_from_net_worth=True)
    db.add(other)
    await db.flush()
    vti = await _hold(db, brokerage, "VTI", 10)
    await _price(db, vti, MONDAY, 300)
    acme = await _hold(db, brokerage, "ACME", 5)
    await _price(db, acme, MONDAY, 100)
    voo = await _hold(db, other, "VOO", 2)
    await _price(db, voo, MONDAY, 500)
    excluded = await db.scalar(select(Holding).where(Holding.security_id == acme.id))
    excluded.exclude_from_net_worth = True
    await db.commit()

    out = await portfolio_trend.portfolio_trend(
        days=3650, interval="1d", account_id=None, account_ids=None,
        security_ids=None, breakdown=False, plans=False, overlay_accounts=None,
        date_from=MONDAY.isoformat(), date_to=MONDAY.isoformat(), db=db, user=user,
        user_acct_ids=[brokerage.id, other.id],
    )
    assert out["series"][-1]["value"] == pytest.approx(3_000 + 500 + 1_000)

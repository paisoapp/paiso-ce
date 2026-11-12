"""The Holdings table shows every position, and adds up to the Dashboard.

A 401(k) with VTI, VXUS and BND read its full value on the Dashboard and
"No holdings yet", $0, on Investments → Stocks & Funds: the list skipped every
401(k)/HSA/529 account and every position without a ticker, and the page added
up its own Market Value from what was left. Both now read one book
(modules/portfolio/positions).
"""
from datetime import date
from decimal import Decimal

import pytest
from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.holdings import list_holdings
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
from app.models.user import User
from app.modules.portfolio import positions
from app.modules.portfolio.summary import get_portfolio_summary

pytestmark = pytest.mark.unit

PRICES = {"VTI": 300.0, "VXUS": 65.0, "BND": 72.0, "AAPL": 200.0, "ACME": 50.0}


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
    monkeypatch.setattr(
        positions, "get_quotes_cached",
        lambda tickers: {t: {"price": PRICES.get(t, 0.0), "day_change": 0.0,
                             "day_change_pct": 0.0, "is_stale": t not in PRICES}
                         for t in tickers},
    )


async def _user(db) -> User:
    u = User(email="book@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.flush()
    return u


async def _linked_401k(db, user, positions_, *, balance=None):
    """A 401(k) holding tickered positions."""
    acct = Account(user_id=user.id, display_name="Company 401(k) (0005)", account_type="401k",
                   subtype="401k")
    db.add(acct)
    await db.flush()
    total = 0.0
    for ticker, shares in positions_:
        sec = Security(ticker=ticker, name=ticker, type="etf")
        db.add(sec)
        await db.flush()
        db.add(Holding(account_id=acct.id, security_id=sec.id, shares=Decimal(str(shares)),
                       cost_basis_total=Decimal(str(shares * PRICES[ticker] * 0.75))))
        total += shares * PRICES[ticker]
    acct.current_balance = Decimal(str(balance if balance is not None else total))
    await db.commit()
    return acct


def _counted(rows):
    return sum(r["current_value"] for r in rows if not r["exclude_from_net_worth"])


async def test_a_401k_lists_its_holdings_and_matches_the_dashboard(db):
    """The acceptance test for one investment book."""
    user = await _user(db)
    acct = await _linked_401k(db, user, [("VTI", 150), ("VXUS", 300), ("BND", 120)])

    rows = await list_holdings(BackgroundTasks(), db, user, [acct.id])
    held = {r["ticker"]: r for r in rows if r["kind"] == "holding"}
    assert set(held) == {"VTI", "VXUS", "BND"}
    assert held["VTI"]["current_value"] == pytest.approx(45_000.0)
    assert held["VTI"]["cost_basis_total"] is not None
    assert held["VTI"]["total_gain"] is not None
    assert held["VTI"]["price_source"] == "live"

    card = await get_portfolio_summary(user.id, db)
    assert card["investment_value"] == pytest.approx(45_000 + 19_500 + 8_640)
    assert _counted(rows) == pytest.approx(card["investment_value"])


async def test_every_kind_of_position_adds_up_to_the_dashboard(db):
    user = await _user(db)
    brokerage = Account(user_id=user.id, display_name="Brokerage", account_type="brokerage")
    manual_401k = Account(user_id=user.id, display_name="Old 401(k)", account_type="401k", other_funds_value=Decimal("500"))
    old_ira = Account(user_id=user.id, display_name="Old IRA", account_type="ira",
                      current_balance=Decimal("12000"))
    aapl = Security(ticker="AAPL", name="Apple", type="stock")
    db.add_all([brokerage, manual_401k, old_ira, aapl])
    await db.flush()
    sold = Security(ticker="OLD", name="Sold long ago", type="stock")
    db.add(sold)
    await db.flush()
    db.add(Holding(account_id=brokerage.id, security_id=aapl.id, shares=Decimal("10")))
    db.add(Holding(account_id=brokerage.id, security_id=sold.id, shares=Decimal("0"),
                   cost_basis_total=Decimal("900")))  # sold out
    excluded_sec = Security(ticker="ACME", name="Acme", type="stock")
    db.add(excluded_sec)
    await db.flush()
    db.add(Holding(account_id=brokerage.id, security_id=excluded_sec.id, shares=Decimal("100"),
                   exclude_from_net_worth=True))
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [brokerage.id])
    kinds = {r["kind"] for r in rows}
    assert kinds == {"holding", "other_funds", "balance"}
    assert len([r for r in rows if r["kind"] == "holding"]) == 2, "the sold-out row is not listed"
    by_kind = {r["kind"]: r for r in rows}
    assert by_kind["other_funds"]["price_source"] == "manual"
    assert by_kind["balance"]["current_value"] == pytest.approx(12_000.0)

    card = await get_portfolio_summary(user.id, db)
    # 10 AAPL + the 401(k)'s "Other funds" + IRA balance; the excluded ACME is out.
    assert card["investment_value"] == pytest.approx(2_000 + 500 + 12_000)
    assert _counted(rows) == pytest.approx(card["investment_value"])


async def test_an_account_is_its_positions_at_live_prices_whatever_the_balance(db):
    """$45k of positions on an account whose balance says $60k.
    The positions are the value, at live prices; the balance plays no part and
    no row makes up the difference."""
    user = await _user(db)
    acct = await _linked_401k(db, user, [("VTI", 150)], balance=60_000)

    rows = await list_holdings(BackgroundTasks(), db, user, [acct.id])
    assert {r["kind"] for r in rows} == {"holding"}
    assert rows[0]["price_source"] == "live"
    assert rows[0]["value_source"] == "positions"

    card = await get_portfolio_summary(user.id, db)
    assert card["investment_value"] == pytest.approx(45_000.0)
    assert _counted(rows) == pytest.approx(45_000.0)


async def test_an_excluded_account_is_listed_but_not_counted(db):
    """A balance-only 401(k) the user excluded: its row is marked excluded and
    no total counts it."""
    from app.modules.portfolio.net_worth_history import reconstruct_net_worth

    user = await _user(db)
    keep = await _linked_401k(db, user, [("VTI", 10)])
    old = Account(user_id=user.id, display_name="Old 401(k)", account_type="401k", subtype="401k", current_balance=Decimal("52000"), exclude_from_net_worth=True)
    db.add(old)
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [keep.id, old.id])
    bal = next(r for r in rows if r["kind"] == "balance")
    assert bal["exclude_from_net_worth"] is True and bal["account_excluded"] is True
    card = await get_portfolio_summary(user.id, db)
    assert card["investment_value"] == pytest.approx(3_000.0)
    assert _counted(rows) == pytest.approx(3_000.0)
    today = date.today()
    series = await reconstruct_net_worth(db, user.id, today, today)
    # VTI has no stored close here, so the trend is the balance fallback alone:
    # the excluded $52k must not be in it.
    assert series[-1]["total_assets"] == pytest.approx(0.0)


async def test_a_manual_stock_plan_keeps_its_positions(db):
    """A stock plan is valued by the positions the user entered."""
    user = await _user(db)
    acct = Account(user_id=user.id, display_name="My RSUs", account_type="brokerage",
                   subtype="stock plan", current_balance=Decimal("1"))
    acme = Security(ticker="ACME", name="Acme", type="stock")
    db.add_all([acct, acme])
    await db.flush()
    db.add(Holding(account_id=acct.id, security_id=acme.id, shares=Decimal("20")))
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [acct.id])
    assert [r["kind"] for r in rows] == ["holding"]
    assert rows[0]["current_value"] == pytest.approx(1_000.0)


async def test_a_balance_only_401k_is_one_row_under_retirement(db):
    """A balance and no securities: one row, in the right tab."""
    from app.api.investments_overview import investments_overview

    user = await _user(db)
    acct = Account(user_id=user.id, display_name="Acme 401(k)", account_type="401k",
                   subtype="401k", current_balance=Decimal("52000"))
    db.add(acct)
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [acct.id])
    assert [(r["kind"], r["current_value"]) for r in rows] == [("balance", pytest.approx(52_000))]
    out = await investments_overview(db=db, user=user)
    assert [g["purpose"] for g in out["groups"]] == ["retirement"]


# ── Investments → Overview ───────────────────────────────────────────────────

async def test_the_overview_groups_by_purpose_and_adds_up_to_the_dashboard(db):
    from app.api.investments_overview import investments_overview

    user = await _user(db)
    school = Account(user_id=user.id, display_name="School 403(b)", account_type="brokerage",
                     subtype="403B", current_balance=Decimal("80000"))
    roth = Account(user_id=user.id, display_name="Roth IRA", account_type="roth_ira",
                   current_balance=Decimal("30000"))
    college = Account(user_id=user.id, display_name="College fund", account_type="brokerage",
                      subtype="brokerage", investment_type="education",
                      current_balance=Decimal("15000"))
    aapl = Security(ticker="AAPL", name="Apple", type="stock")
    db.add_all([school, roth, college, aapl])
    await db.flush()
    broker = Account(user_id=user.id, display_name="Brokerage", account_type="brokerage")
    db.add(broker)
    await db.flush()
    db.add(Holding(account_id=broker.id, security_id=aapl.id, shares=Decimal("10")))
    await db.commit()

    out = await investments_overview(db=db, user=user)
    card = await get_portfolio_summary(user.id, db)
    assert out["total"] == pytest.approx(card["investment_value"])
    assert sum(g["total"] for g in out["groups"]) == pytest.approx(out["total"])

    groups = {g["purpose"]: g for g in out["groups"]}
    assert set(groups) == {"retirement", "education", "investing"}
    assert groups["retirement"]["by_tax"] == {
        "tax_deferred": pytest.approx(80_000), "tax_free": pytest.approx(30_000)}
    assert groups["investing"]["total"] == pytest.approx(2_000)       # 10 AAPL
    # A brokerage account the user filed under Education.
    assert groups["education"]["total"] == pytest.approx(15_000)
    assert groups["education"]["by_tax"] == {"taxable": pytest.approx(15_000)}
    school_card = next(a for a in groups["retirement"]["accounts"] if a["name"] == "School 403(b)")
    assert school_card["subtype_label"] == "403(b)"
    assert school_card["value"] == pytest.approx(80_000)


async def test_other_funds_add_to_a_hand_kept_plans_tickers(db):
    """A hand-kept 401(k): 10 VTI priced live, plus the funds with no ticker
    entered as one value. Both count, in every view."""
    from app.api.investments_overview import investments_overview

    user = await _user(db)
    plan = Account(user_id=user.id, display_name="Old 401(k)", account_type="401k",
                   subtype="401k", other_funds_value=Decimal("12000"),
                   other_funds_as_of=date(2026, 8, 1), current_balance=Decimal("99999"))
    vti = Security(ticker="VTI", name="Vanguard Total Stock Market ETF", type="etf")
    db.add_all([plan, vti])
    await db.flush()
    db.add(Holding(account_id=plan.id, security_id=vti.id, shares=Decimal("10")))
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [plan.id])
    kinds = {r["kind"]: r for r in rows}
    assert kinds["other_funds"]["current_value"] == pytest.approx(12_000)
    card = await get_portfolio_summary(user.id, db)
    assert card["investment_value"] == pytest.approx(3_000 + 12_000), "the stale balance is not counted"
    assert _counted(rows) == pytest.approx(card["investment_value"])
    out = await investments_overview(db=db, user=user)
    c = out["groups"][0]["accounts"][0]
    assert c["value"] == pytest.approx(15_000)
    assert c["stale"] is True and c["updated_by_hand_on"] == "2026-08-01"

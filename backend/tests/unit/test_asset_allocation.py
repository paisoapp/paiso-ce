"""Positions grouped by what they are invested in, separately from the account.

An IRA and a brokerage account can both hold a bond fund: the account says how the money is
taxed, the security says what it is exposed to.
"""
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.investments_overview import investments_allocation, investments_overview
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security, SecurityInfo
from app.models.user import User
from app.modules.investments.asset_class import classify
from app.modules.portfolio import positions
from app.modules.portfolio.summary import get_portfolio_summary

pytestmark = pytest.mark.unit


def _sec(**kw):
    return SimpleNamespace(type=kw.get("type", "etf"), name=kw.get("name", ""))


def test_a_stock_in_the_real_estate_sector_is_real_estate():
    assert classify(security=_sec(type="stock"),
                    info={"quoteType": "EQUITY", "sector": "Real Estate"}) == "real_estate"


@pytest.mark.parametrize("category,expected", [
    ("Intermediate Core Bond", "fixed_income"),
    ("Target-Date 2050", "multi_asset"),
    ("Large Blend", "equity"),
    ("Foreign Large Blend", "equity"),
    ("Real Estate", "real_estate"),
])
def test_a_funds_category_classifies_a_manual_ticker(category, expected):
    assert classify(security=_sec(type="mutual_fund"),
                    info={"quoteType": "MUTUALFUND", "category": category}) == expected


@pytest.mark.parametrize("name,expected", [
    ("Target Retirement 2050 Trust", "multi_asset"),
    ("Stable Value Fund", "cash"),
    ("Total Bond Market Index", "fixed_income"),
    ("S&P 500 Index Fund", "equity"),
    ("Mystery Collective Trust", "unclassified"),
])
def test_a_ticker_less_fund_is_classified_by_its_name(name, expected):
    assert classify(name=name) == expected


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
    prices = {"VTI": 300.0, "BND": 72.0, "VNQ": 90.0}
    monkeypatch.setattr(positions, "get_quotes_cached",
                        lambda ts: {t: {"price": prices.get(t, 0.0)} for t in ts})


async def test_allocation_adds_up_to_the_dashboard(db):
    user = User(email="alloc@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    roth = Account(user_id=user.id, display_name="Roth IRA", account_type="roth_ira")
    k401 = Account(user_id=user.id, display_name="Old 401(k)", account_type="401k", other_funds_value=Decimal("1000"))  # 1,000 unclassified
    old_ira = Account(user_id=user.id, display_name="Old IRA", account_type="ira",
                      current_balance=Decimal("5000"))
    vti = Security(ticker="VTI", name="Vanguard Total Stock Market ETF", type="etf")
    bnd = Security(ticker="BND", name="Vanguard Total Bond Market ETF", type="etf")
    vnq = Security(ticker="VNQ", name="Vanguard Real Estate ETF", type="etf")
    db.add_all([roth, k401, old_ira, vti, bnd, vnq])
    await db.flush()
    db.add(SecurityInfo(security_id=vnq.id, updated_at=date(2026, 10, 1),
                        info_json='{"quoteType": "ETF", "category": "Real Estate"}'))
    db.add_all([
        Holding(account_id=roth.id, security_id=vti.id, shares=Decimal("10")),   # 3,000 equity
        Holding(account_id=roth.id, security_id=bnd.id, shares=Decimal("50")),   # 3,600 bonds
        Holding(account_id=roth.id, security_id=vnq.id, shares=Decimal("10")),   #   900 REIT
    ])
    await db.commit()

    out = await investments_allocation(db=db, user=user)
    card = await get_portfolio_summary(user.id, db)
    assert out["total"] == pytest.approx(card["investment_value"])
    by = {c["key"]: c["value"] for c in out["by_asset_class"]}
    assert by == {
        "equity": pytest.approx(3_000), "fixed_income": pytest.approx(3_600),
        "real_estate": pytest.approx(900), "unclassified": pytest.approx(1_000 + 5_000),
    }
    assert sum(by.values()) == pytest.approx(out["total"])
    purposes = {p["key"]: p["total"] for p in out["by_purpose"]}
    assert purposes == {"retirement": pytest.approx(13_500)}
    taxes = {t["key"]: t["total"] for t in out["by_tax"]}
    assert taxes["tax_free"] == pytest.approx(7_500)


async def test_excluded_from_net_worth_still_counts_on_investments(db):
    """an excluded account and an excluded holding are left out of net
    worth, and counted everywhere on Investments: the Overview total and its
    account values, and the allocation. The Overview names the difference."""
    user = User(email="excl@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    roth = Account(user_id=user.id, display_name="Roth IRA", account_type="roth_ira")
    hsa = Account(user_id=user.id, display_name="HSA", account_type="hsa",
                  current_balance=Decimal("4000"), exclude_from_net_worth=True)
    vti = Security(ticker="VTI", name="Vanguard Total Stock Market ETF", type="etf")
    bnd = Security(ticker="BND", name="Vanguard Total Bond Market ETF", type="etf")
    db.add_all([roth, hsa, vti, bnd])
    await db.flush()
    db.add_all([
        Holding(account_id=roth.id, security_id=vti.id, shares=Decimal("10")),   # 3,000
        Holding(account_id=roth.id, security_id=bnd.id, shares=Decimal("50"),    # 3,600, excluded
                exclude_from_net_worth=True),
    ])
    await db.commit()

    summary = await get_portfolio_summary(user.id, db)
    assert summary["investment_value"] == pytest.approx(3_000)

    overview = await investments_overview(db=db, user=user)
    assert overview["total"] == pytest.approx(3_000 + 3_600 + 4_000)
    assert overview["excluded_total"] == pytest.approx(3_600 + 4_000)
    cards = {c["name"]: c for g in overview["groups"] for c in g["accounts"]}
    assert cards["Roth IRA"]["value"] == pytest.approx(6_600)
    assert cards["Roth IRA"]["excluded_value"] == pytest.approx(3_600)
    assert cards["HSA"]["value"] == pytest.approx(4_000)
    assert cards["HSA"]["excluded"] is True

    alloc = await investments_allocation(db=db, user=user)
    assert alloc["total"] == pytest.approx(3_000 + 3_600 + 4_000)

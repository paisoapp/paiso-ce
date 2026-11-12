"""Portfolio-page accuracy: fee analysis, loan balances, gain/loss, donut, dashboard.

Each end-to-end test pins one bug the Portfolio / Dashboard pages shipped with:
expense ratios read 100× too high, unknown fees diluting the ratio toward 0%,
loans valued at original principal, gain counted
on value with no cost basis, donut slices not summing to the total shown in
its centre, and dashboard income counting transfers.
"""
from datetime import date, timedelta
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.asset import Asset, Loan, PaymentSchedule
from app.models.holding import Holding
from app.models.security import Security
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.investments.market_data import expense_ratio_pct_from_info
from app.modules.portfolio.fees import (
    FeePosition,
    security_er_fraction,
    summarize_fees,
)
from app.modules.portfolio.valuation import current_loan_balance, loan_balance_at

pytestmark = pytest.mark.unit


# ── Units ───────────────────────────────────────────────────────────────────

def test_security_ratio_is_a_percent():
    """The Add Holding form stores 0.03 for 0.03% — a percent, not a fraction."""
    assert security_er_fraction(Decimal("0.03"), "etf") == pytest.approx(0.0003)


def test_a_stock_is_a_known_zero_but_an_unrated_fund_is_unknown():
    assert security_er_fraction(None, "stock") == 0.0
    assert security_er_fraction(None, "fixed_income") == 0.0
    assert security_er_fraction(None, "mutual_fund") is None
    assert security_er_fraction(None, "target_date_fund") is None


def test_yfinance_ratio_units():
    """Checked against live data: netExpenseRatio is a percent,
    annualReportExpenseRatio a fraction."""
    assert expense_ratio_pct_from_info({"netExpenseRatio": 0.03}) == 0.03
    assert expense_ratio_pct_from_info({"annualReportExpenseRatio": 0.00015}) == pytest.approx(0.015)
    assert expense_ratio_pct_from_info({}) is None
    assert expense_ratio_pct_from_info({"netExpenseRatio": 45.0}) is None


# ── summarize_fees ──────────────────────────────────────────────────────────

def test_fee_is_value_times_ratio():
    out = summarize_fees([FeePosition("VOO", "VOO", "holding", 100_000, 0.0003)])
    assert out["annual_fee"] == pytest.approx(30.0)
    assert out["weighted_expense_ratio"] == pytest.approx(0.03)
    assert out["coverage_pct"] == 100.0


def test_unknown_funds_do_not_dilute_the_ratio():
    out = summarize_fees([
        FeePosition("Cheap", "VOO", "holding", 50_000, 0.001),
        FeePosition("Mystery", None, "holding", 50_000, None),
    ])
    assert out["weighted_expense_ratio"] == pytest.approx(0.1)  # not 0.05
    assert out["annual_fee"] == pytest.approx(50.0)
    assert out["coverage_pct"] == 50.0
    assert out["unknown_count"] == 1
    assert out["unknown_value"] == pytest.approx(50_000)


def test_unknown_funds_are_named_largest_first():
    """The card names them, so the list has to be ordered and deduped."""
    out = summarize_fees([
        FeePosition("Small mystery", "AAA", "holding", 1_000, None),
        FeePosition("Big mystery", "ZZZ", "holding", 90_000, None),
        FeePosition("Known", "VOO", "holding", 10_000, 0.0003),
    ])
    assert [f["ticker"] for f in out["unknown_funds"]] == ["ZZZ", "AAA"]
    assert out["unknown_funds"][0]["value"] == pytest.approx(90_000)
    assert out["unknown_fund_count"] == 2


def test_one_unknown_fund_in_two_accounts_is_one_fund():
    """`unknown_count` counts positions; the UI's count must not double it."""
    out = summarize_fees([
        FeePosition("Mystery", "AAA", "holding", 1_000, None),
        FeePosition("Mystery", "AAA", "holding", 2_000, None),
    ])
    assert out["unknown_count"] == 2
    assert out["unknown_fund_count"] == 1
    assert len(out["unknown_funds"]) == 1
    assert out["unknown_funds"][0]["value"] == pytest.approx(3_000)


def test_a_stock_counts_toward_coverage_at_zero():
    out = summarize_fees([
        FeePosition("Fund", "F", "holding", 10_000, 0.01),
        FeePosition("Apple", "AAPL", "holding", 10_000, 0.0),
    ])
    assert out["weighted_expense_ratio"] == pytest.approx(0.5)
    assert out["coverage_pct"] == 100.0
    assert [r["ticker"] for r in out["top_costs"]] == ["F"]


def test_the_same_fund_in_two_accounts_is_one_top_cost_line():
    out = summarize_fees([
        FeePosition("Fund", "ABC", "holding", 10_000, 0.01),
        FeePosition("Fund", "ABC", "holding", 5_000, 0.01),
        FeePosition("Other", "XYZ", "holding", 1_000, 0.02),
    ])
    assert out["top_costs"][0]["ticker"] == "ABC"
    assert out["top_costs"][0]["annual_fee"] == pytest.approx(150.0)
    assert out["top_costs"][0]["expense_ratio"] == pytest.approx(1.0)


def test_projection_grows_with_fees():
    out = summarize_fees([FeePosition("F", "F", "holding", 100_000, 0.01)])
    g = 1.06
    expected = 100_000 * (g ** 10 - (g * 0.99) ** 10)
    assert out["projected_fee_cost"] == pytest.approx(expected, rel=1e-6)


def test_no_positions_is_all_zero():
    out = summarize_fees([])
    assert out["weighted_expense_ratio"] == 0.0
    assert out["coverage_pct"] == 0.0
    assert out["top_costs"] == []


# ── Loan balances ───────────────────────────────────────────────────────────

def _loan(**kw):
    base = dict(principal=Decimal("300000"), rate_apr=Decimal("6"), term_months=360,
                origination=date(2020, 1, 1), balance_override=None,
                balance_override_date=None, payment_schedule=[])
    base.update(kw)
    return SimpleNamespace(**base)


def test_without_override_the_loan_amortizes_instead_of_reading_original_principal():
    bal = current_loan_balance(_loan(), date(2025, 1, 1))
    assert 250_000 < bal < 300_000


def test_the_schedule_wins_over_the_formula():
    sched = [SimpleNamespace(payment_date=date(2024, 1, 1), balance=Decimal("123456"))]
    assert current_loan_balance(_loan(payment_schedule=sched), date(2024, 6, 1)) == 123456.0


def test_override_is_carried_forward_by_later_payments():
    sched = [
        SimpleNamespace(payment_date=date(2024, 2, 1), balance=Decimal("199000")),
        SimpleNamespace(payment_date=date(2024, 3, 1), balance=Decimal("198000")),
        SimpleNamespace(payment_date=date(2024, 4, 1), balance=Decimal("197000")),
    ]
    loan = _loan(balance_override=Decimal("200000"), balance_override_date=date(2024, 1, 15),
                 payment_schedule=sched)
    assert current_loan_balance(loan, date(2024, 1, 20)) == 200_000.0
    assert current_loan_balance(loan, date(2024, 3, 10)) == 198_000.0


def test_history_ignores_the_override():
    loan = _loan(balance_override=Decimal("1"), balance_override_date=date(2024, 1, 1))
    assert loan_balance_at(loan, date(2019, 1, 1)) == 300_000.0


# ── End to end through get_portfolio_summary ────────────────────────────────

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
def quotes(monkeypatch):
    from app.modules.portfolio import positions

    prices: dict[str, float] = {}
    monkeypatch.setattr(
        positions, "get_quotes_cached",
        lambda tickers: {t: {"price": prices.get(t, 0.0), "is_stale": False} for t in tickers},
    )
    return prices


async def _user(db) -> User:
    u = User(email="fees@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.commit()
    return u


async def test_summary_fee_analysis_across_sources(db, quotes):
    from app.modules.portfolio.summary import get_portfolio_summary

    quotes.update({"VOO": 500.0, "AAPL": 200.0, "MYST": 10.0})
    u = await _user(db)
    brokerage = Account(user_id=u.id, display_name="Brokerage", account_type="brokerage")
    manual_ira = Account(user_id=u.id, display_name="Old IRA", account_type="ira",
                         current_balance=Decimal("40000"))
    voo = Security(ticker="VOO", name="Vanguard S&P 500", type="etf", expense_ratio=Decimal("0.03"))
    aapl = Security(ticker="AAPL", name="Apple", type="stock")
    myst = Security(ticker="MYST", name="Mystery Fund", type="mutual_fund")
    db.add_all([brokerage, manual_ira, voo, aapl, myst])
    await db.flush()
    db.add_all([
        Holding(account_id=brokerage.id, security_id=voo.id, shares=Decimal("200")),   # $100k
        Holding(account_id=brokerage.id, security_id=aapl.id, shares=Decimal("50")),   # $10k
        Holding(account_id=brokerage.id, security_id=myst.id, shares=Decimal("1000")), # $10k
    ])
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    fa = out["fee_analysis"]

    # $30 (VOO) + $0 (AAPL). The old code charged VOO at 3% = $3,000.
    assert fa["annual_fee"] == pytest.approx(30.0)
    # Fee-bearing: 100k + 10k + 10k. The $40k manual IRA is not a fund.
    assert fa["fee_bearing_value"] == pytest.approx(120_000)
    assert fa["er_known_value"] == pytest.approx(110_000)
    assert fa["weighted_expense_ratio"] == pytest.approx(30 / 110_000 * 100, abs=1e-4)
    assert fa["unknown_count"] == 1
    assert out["annual_fee_drag"] == fa["annual_fee"]
    assert out["weighted_expense_ratio"] == fa["weighted_expense_ratio"]
    assert out["investment_value"] == pytest.approx(160_000)


async def test_gain_is_measured_only_on_value_with_a_cost_basis(db, quotes):
    from app.modules.portfolio.summary import get_portfolio_summary

    quotes["VOO"] = 500.0
    u = await _user(db)
    brokerage = Account(user_id=u.id, display_name="Brokerage", account_type="brokerage")
    manual_401k = Account(user_id=u.id, display_name="401k", account_type="401k",
                          current_balance=Decimal("80000"))
    voo = Security(ticker="VOO", name="VOO", type="etf")
    db.add_all([brokerage, manual_401k, voo])
    await db.flush()
    db.add(Holding(account_id=brokerage.id, security_id=voo.id, shares=Decimal("20"),
                   cost_basis_total=Decimal("8000")))  # worth $10k
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    assert out["investment_value"] == pytest.approx(90_000)
    # Was 90,000 − 8,000 = +$82,000 "gain".
    assert out["total_gain"] == pytest.approx(2_000)
    assert out["costed_value"] == pytest.approx(10_000)


async def test_donut_slices_sum_to_total_assets(db, quotes):
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    db.add_all([
        Account(user_id=u.id, display_name="Checking", account_type="checking",
                current_balance=Decimal("5000")),
        Account(user_id=u.id, display_name="IRA", account_type="ira",
                current_balance=Decimal("20000")),
        Asset(user_id=u.id, category="primary_home", name="Home",
              current_value=Decimal("400000"), ownership_pct=Decimal("100")),
        Asset(user_id=u.id, category="vehicle", name="Car",
              current_value=Decimal("15000"), ownership_pct=Decimal("100")),
    ])
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    labels = {b["label"] for b in out["asset_breakdown"]}
    assert "cash" in labels
    assert sum(b["value"] for b in out["asset_breakdown"]) == pytest.approx(out["total_assets"])


async def test_asset_loan_without_override_is_not_its_original_principal(db, quotes):
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    home = Asset(user_id=u.id, category="primary_home", name="Home",
                 current_value=Decimal("600000"), ownership_pct=Decimal("100"))
    db.add(home)
    await db.flush()
    loan = Loan(asset_id=home.id, principal=Decimal("300000"), rate_apr=Decimal("6"),
                term_months=360, origination=date.today() - timedelta(days=365 * 5))
    db.add(loan)
    await db.flush()
    db.add(PaymentSchedule(loan_id=loan.id, month_number=60,
                           payment_date=date.today() - timedelta(days=10),
                           principal=Decimal("500"), interest=Decimal("1000"),
                           balance=Decimal("279000")))
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    assert out["total_loan_balance"] == pytest.approx(279_000)


# ── Dashboard income / expenses ─────────────────────────────────────────────

async def test_dashboard_excludes_transfers_from_income_and_expenses(db, quotes):
    from app.api.dashboard import dashboard

    u = await _user(db)
    checking = Account(user_id=u.id, display_name="Checking", account_type="checking",
                       current_balance=Decimal("1000"))
    db.add(checking)
    salary = Category(user_id=u.id, name="Salary", treatment="income", is_income=True)
    groceries = Category(user_id=u.id, name="Groceries", treatment="expense", color="#111")
    transfer = Category(user_id=u.id, name="Credit Card Payment", treatment="transfer")
    db.add_all([salary, groceries, transfer])
    await db.flush()
    today = date.today()
    db.add_all([
        Transaction(account_id=checking.id, date_posted=today, amount=Decimal("5000"),
                    description="Pay", category_id=salary.id),
        Transaction(account_id=checking.id, date_posted=today, amount=Decimal("-400"),
                    description="Store", category_id=groceries.id),
        Transaction(account_id=checking.id, date_posted=today, amount=Decimal("-2000"),
                    description="Card payment", category_id=transfer.id),
        Transaction(account_id=checking.id, date_posted=today, amount=Decimal("3000"),
                    description="From savings", category_id=transfer.id),
    ])
    await db.commit()

    out = await dashboard(BackgroundTasks(), db=db, user=u, user_acct_ids=[checking.id])
    assert out["monthly_income"] == pytest.approx(5000)
    assert out["monthly_expenses"] == pytest.approx(400)
    assert out["savings_rate"] == pytest.approx(92.0)
    assert [c["name"] for c in out["top_expense_categories"]] == ["Groceries"]

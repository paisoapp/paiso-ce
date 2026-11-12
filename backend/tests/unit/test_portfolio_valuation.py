"""Shared account valuation: additive tracking + loan/mortgage liabilities."""
from datetime import date
from decimal import Decimal

import pytest

from app.modules.portfolio import positions
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.asset import Asset, Loan
from app.models.user import User
from app.modules.portfolio.valuation import (
    DEBT_TYPES,
    LOAN_TYPES,
    is_asset_backed_loan_account,
    loan_account_debt,
    tracked_account_value,
)

pytestmark = pytest.mark.unit


# ── Classification ──────────────────────────────────────────────────────────

def test_mortgage_is_a_debt_type():
    """The bug this module exists to fix: mortgage was in no debt set, so a
    mortgage account's balance never reached total_liabilities."""
    assert "mortgage" in LOAN_TYPES
    assert "mortgage" in DEBT_TYPES
    assert "loan" in LOAN_TYPES
    assert "credit_card" in DEBT_TYPES


# ── tracked_account_value ───────────────────────────────────────────────────

def test_sources_are_summed_not_shortcircuited():
    """An `if / elif` chain over the sources returned only the first match, so
    a single tickered holding hid everything else."""
    av = tracked_account_value(
        7,
        holdings={7: 1000.0},
        other_funds={7: 250.0},
        fallback_balance=99999.0,
    )
    assert av.value == pytest.approx(1250.0)
    assert av.tracked is True
    assert av.sources == frozenset({"holdings", "other_funds"})


def test_falls_back_to_balance_when_untracked():
    av = tracked_account_value(7, holdings={}, fallback_balance=500.0)
    assert av.value == 500.0
    assert av.tracked is False
    assert av.sources == frozenset()


def test_zero_valued_source_still_counts_as_tracked():
    """Membership decides, not magnitude — an account whose positions really
    are worth $0 must not silently revert to a stale manual balance."""
    av = tracked_account_value(7, holdings={7: 0.0}, fallback_balance=12345.0)
    assert av.value == 0.0
    assert av.tracked is True


def test_only_the_matching_account_contributes():
    av = tracked_account_value(7, holdings={8: 1000.0}, fallback_balance=42.0)
    assert av.value == 42.0
    assert av.tracked is False


def test_missing_source_maps_are_ignored():
    av = tracked_account_value(7, other_funds={7: 10.0})
    assert av.value == 10.0
    assert av.sources == frozenset({"other_funds"})


# ── loan_account_debt ───────────────────────────────────────────────────────

def _acct(**kw):
    return Account(user_id=1, display_name="x", account_type="mortgage", **kw)


def test_standalone_mortgage_balance_is_debt():
    a = _acct(current_balance=Decimal("250000"))
    assert is_asset_backed_loan_account(a) is False
    assert loan_account_debt(a) == pytest.approx(250000.0)


def test_negative_balance_is_still_positive_debt():
    """Sign varies by source — a hand-entered balance is positive, some OFX
    exports negative. The magnitude is what is owed."""
    assert loan_account_debt(_acct(current_balance=Decimal("-250000"))) == pytest.approx(250000.0)


def test_asset_backed_mortgage_is_not_double_counted():
    """POST /api/mortgage builds an Account+Asset+Loan trio; the debt already
    reaches net worth through Asset.loan."""
    a = _acct(current_balance=Decimal("250000"), linked_asset_id=3)
    assert is_asset_backed_loan_account(a) is True
    assert loan_account_debt(a) == 0.0


def test_null_balance_is_zero_debt():
    assert loan_account_debt(_acct(current_balance=None)) == 0.0


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


async def _user(db) -> User:
    u = User(email="v@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.flush()
    await db.commit()
    return u


async def test_summary_counts_a_mortgage_account_with_no_property(db):
    """A mortgage account with no linked Asset
    used to contribute nothing, so net worth read too high."""
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    db.add(Account(user_id=u.id, display_name="Checking", account_type="checking",
                   current_balance=Decimal("10000")))
    db.add(Account(user_id=u.id, display_name="Home Loan (4321)",
                   account_type="mortgage", current_balance=Decimal("250000")))
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    assert out["total_loan_account_balance"] == pytest.approx(250000.0)
    assert out["total_liabilities"] == pytest.approx(250000.0)
    assert out["net_worth"] == pytest.approx(10000.0 - 250000.0)


async def test_summary_counts_a_standalone_loan_account(db):
    """`loan` accounts were dropped too: summary computed liabilities from
    credit cards and Asset-linked loans only."""
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    db.add(Account(user_id=u.id, display_name="Student Loan", account_type="loan",
                   current_balance=Decimal("18000")))
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    assert out["total_liabilities"] == pytest.approx(18000.0)


async def test_summary_does_not_double_count_an_asset_backed_mortgage(db):
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    asset = Asset(user_id=u.id, category="primary_home", name="Home",
                  current_value=Decimal("600000"), ownership_pct=Decimal("100"))
    db.add(asset)
    await db.flush()
    db.add(Loan(asset_id=asset.id, principal=Decimal("300000"),
                rate_apr=Decimal("6.5"), term_months=360,
                origination=date(2020, 1, 1),
                balance_override=Decimal("250000")))
    db.add(Account(user_id=u.id, display_name="Home Loan", account_type="mortgage",
                   current_balance=Decimal("250000"), linked_asset_id=asset.id))
    await db.commit()

    out = await get_portfolio_summary(u.id, db)
    # Counted once, via the Asset's Loan — not twice.
    assert out["total_loan_balance"] == pytest.approx(250000.0)
    assert out["total_loan_account_balance"] == 0.0
    assert out["total_liabilities"] == pytest.approx(250000.0)
    assert out["net_worth"] == pytest.approx(600000.0 - 250000.0)


async def test_breakdown_lists_a_mortgage_account_as_a_loan(db, monkeypatch):
    from app.modules.portfolio import breakdown as bd

    monkeypatch.setattr(positions, "get_quotes_cached", lambda ts: {t: {"price": 0.0} for t in ts})

    u = await _user(db)
    db.add(Account(user_id=u.id, display_name="Home Loan (4321)",
                   account_type="mortgage", current_balance=Decimal("250000")))
    await db.commit()

    out = await bd.get_portfolio_breakdown(u.id, db)
    assert [r["type"] for r in out["loans"]] == ["mortgage"]
    assert out["loans"][0]["type_label"] == "Mortgage"


# ── Ticker-less positions must not zero the account that holds them ─────────
#
# Ticker-less securities are Holdings too, and because
# tracked_account_value keys on *membership*, a 401(k) of target-date funds
# would flip from reporting its balance to reporting $0 unless those positions
# can be priced. Their only price source is the institution mark the sync
# persists to price_history.

async def test_a_ticker_less_holding_is_priced_from_persisted_closes(db, monkeypatch):
    from app.models.holding import Holding
    from app.models.security import PriceHistory, Security
    from app.modules.portfolio import breakdown as bd

    # No ticker means no quote is asked for; blow up if one is.
    monkeypatch.setattr(positions, "get_quotes_cached", lambda ts: {} if not ts else pytest.fail(
        "a ticker-less holding must not be sent to the quote path"))

    u = await _user(db)
    acct = Account(user_id=u.id, display_name="Workplace 401(k)",
                   account_type="401k", current_balance=Decimal("52000"))
    sec = Security(cusip="000000AA1", name="Target Date 2050 Fund",
                   type="target_date_fund")
    db.add_all([acct, sec])
    await db.flush()
    db.add(Holding(account_id=acct.id, security_id=sec.id, shares=Decimal("100")))
    db.add(PriceHistory(security_id=sec.id, as_of=date(2026, 9, 5),
                        close=Decimal("25.75")))
    await db.commit()

    out = await bd.get_portfolio_breakdown(u.id, db)
    row = next(r for r in out["investments"] if r["id"] == acct.id)
    assert row["value"] == pytest.approx(2575.0), "100 units at the persisted mark"


async def test_the_most_recent_close_wins(db):
    from app.models.security import PriceHistory, Security
    from app.modules.portfolio.valuation import _latest_closes_dated

    sec = Security(cusip="000000AA1", name="Target Date 2050", type="target_date_fund")
    db.add(sec)
    await db.flush()
    db.add_all([
        PriceHistory(security_id=sec.id, as_of=date(2026, 9, 1), close=Decimal("24.00")),
        PriceHistory(security_id=sec.id, as_of=date(2026, 9, 5), close=Decimal("25.75")),
        PriceHistory(security_id=sec.id, as_of=date(2026, 9, 3), close=Decimal("25.00")),
    ])
    await db.commit()

    assert (await _latest_closes_dated(db, [sec.id]))[sec.id][0] == pytest.approx(25.75)


async def test_the_latest_closes_are_empty_rather_than_querying_for_nothing(db):
    from app.modules.portfolio.valuation import _latest_closes_dated

    assert await _latest_closes_dated(db, []) == {}
    assert await _latest_closes_dated(db, [None]) == {}


# ── What Stocks & Funds lists, and what it must not ─────────────────────────

async def test_a_plan_account_counts_toward_net_worth(db, monkeypatch):
    """A 401(k)'s positions value it. (They are listed in Holdings too; see
    test_unified_holdings.)"""
    from app.models.holding import Holding
    from app.models.security import Security
    from app.modules.portfolio import breakdown as bd

    monkeypatch.setattr(positions, "get_quotes_cached", lambda ts: {t: {"price": 100.0} for t in ts})

    u = await _user(db)
    acct = Account(user_id=u.id, display_name="Workplace 401(k)",
                   account_type="401k", current_balance=Decimal("52000"))
    sec = Security(ticker="VTI", name="Vanguard Total", type="etf")
    db.add_all([acct, sec])
    await db.flush()
    db.add(Holding(account_id=acct.id, security_id=sec.id, shares=Decimal("10")))
    await db.commit()

    out = await bd.get_portfolio_breakdown(u.id, db)
    row = next(r for r in out["investments"] if r["id"] == acct.id)
    assert row["value"] == pytest.approx(1000.0), "valued from its positions"


# ── A co-owned asset carries its share of the loan ────────────────────
# The value was scaled by ownership_pct and the loan was not, so half of a
# home was set against the whole of its mortgage.

async def _half_owned_home(db):
    u = await _user(db)
    asset = Asset(user_id=u.id, category="primary_home", name="Shared Home",
                  current_value=Decimal("800000"), ownership_pct=Decimal("50"))
    db.add(asset)
    await db.flush()
    db.add(Loan(asset_id=asset.id, principal=Decimal("500000"),
                rate_apr=Decimal("6.5"), term_months=360,
                origination=date(2020, 1, 1),
                balance_override=Decimal("400000")))
    await db.commit()
    return u


async def test_summary_scales_a_co_owned_loan_by_the_ownership_share(db):
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _half_owned_home(db)
    out = await get_portfolio_summary(u.id, db)

    assert out["total_loan_balance"] == pytest.approx(200000.0)
    assert out["total_liabilities"] == pytest.approx(200000.0)
    assert out["net_worth"] == pytest.approx(400000.0 - 200000.0)


async def test_breakdown_scales_a_co_owned_loan_and_its_equity(db):
    from app.modules.portfolio.breakdown import get_portfolio_breakdown

    u = await _half_owned_home(db)
    row = (await get_portfolio_breakdown(u.id, db))["mortgages"][0]

    assert row["property_value"] == pytest.approx(400000.0)
    assert row["loan_balance"] == pytest.approx(200000.0)
    assert row["equity"] == pytest.approx(200000.0)


async def test_the_trend_agrees_with_the_summary_for_a_co_owned_loan(db):
    from app.modules.portfolio.net_worth_history import reconstruct_net_worth
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _half_owned_home(db)
    today = date.today()
    points = await reconstruct_net_worth(db, u.id, today, today)
    summary = await get_portfolio_summary(u.id, db)

    assert points[-1]["total_liabilities"] == pytest.approx(200000.0)
    assert points[-1]["net_worth"] == pytest.approx(summary["net_worth"])


async def test_a_wholly_owned_loan_is_unchanged(db):
    from app.modules.portfolio.valuation import owned_loan_balance, ownership_share

    class _Asset:
        ownership_pct = None
        loan = None

    assert ownership_share(_Asset()) == 1.0
    assert owned_loan_balance(_Asset()) == 0.0


async def test_the_trend_splits_its_totals_by_kind_of_account(db):
    """The balance trend on Transactions draws one line per kind. The
    kinds must add back up to the totals the same point reports."""
    from app.modules.portfolio.net_worth_history import reconstruct_net_worth

    u = await _half_owned_home(db)
    today = date.today()
    point = (await reconstruct_net_worth(db, u.id, today, today))[-1]

    assert point["mortgages"] == pytest.approx(200000.0)
    assert point["credit_cards"] + point["loans"] + point["mortgages"] == pytest.approx(
        point["total_liabilities"]
    )
    # Property is an asset but not an account type, so the two account kinds
    # can only fall short of total assets, never exceed them.
    assert point["cash"] + point["investments"] <= point["total_assets"] + 0.01

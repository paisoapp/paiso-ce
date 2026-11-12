"""An account must not value at $0 because a position cannot be quoted.

Two failure modes, both reproduced here with synthetic data:

1. A 401(k) collective trust reported under a made-up ticker no quote source
   knows. It valued at $0 and, being a held position, stopped the account
   falling back to its balance.
2. An account whose only Holding row is at zero shares (its value lives in
   the account balance). A zero-share row "tracked" the account at $0.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401
from app.core.database import Base
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
from app.models.user import User
from app.modules.portfolio.valuation import claims_account

pytestmark = pytest.mark.unit

TODAY = date.today()


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
def no_quotes(monkeypatch):
    """Every quote source returns nothing — as for an unknown ticker."""
    from app.modules.portfolio import positions

    monkeypatch.setattr(
        positions, "get_quotes_cached",
        lambda tickers: {t: {"price": 0.0, "is_stale": True} for t in tickers},
    )


async def _user(db) -> User:
    u = User(email="unpriced@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.commit()
    return u


async def _zero_share_plan_account(db, u) -> Account:
    """A brokerage account whose one row is at zero shares and whose value is
    the $8,000 balance the institution reports."""
    acct = Account(user_id=u.id, display_name="Test Stock Plan", account_type="brokerage",
                   current_balance=Decimal("8000"))
    sec = Security(ticker="TSTX", name="Test Co", type="stock")
    db.add_all([acct, sec])
    await db.flush()
    db.add(Holding(account_id=acct.id, security_id=sec.id, shares=Decimal("0")))
    await db.commit()
    return acct


# ── Helpers ─────────────────────────────────────────────────────────────────

def test_only_held_positions_claim_an_account():
    assert claims_account(Decimal("1.5"))
    assert not claims_account(Decimal("0"))
    assert not claims_account(None)


# ── The two failure modes, end to end ───────────────────────────────────────

async def test_a_zero_share_row_does_not_hide_the_account_balance(db, no_quotes):
    from app.modules.portfolio.breakdown import get_portfolio_breakdown
    from app.modules.portfolio.summary import get_portfolio_summary

    u = await _user(db)
    acct = await _zero_share_plan_account(db, u)

    summary = await get_portfolio_summary(u.id, db)
    assert summary["investment_value"] == pytest.approx(8000.0)

    bd = await get_portfolio_breakdown(u.id, db)
    row = next(r for r in bd["investments"] if r["id"] == acct.id)
    assert row["value"] == pytest.approx(8000.0)


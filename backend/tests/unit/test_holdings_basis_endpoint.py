"""Cost basis across the endpoints that write it.

The number has two authors — `recalc_holding`, which derives it from the trade
history, and `PATCH /holdings/{id}`, which takes it from a form. Where both can
write, the derived one has to win, or a stale form field silently discards a
figure the user just entered as trades.
"""
from datetime import date
from decimal import Decimal

import pytest

from app.modules.portfolio import positions
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api import holdings as holdings_api
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
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


@pytest.fixture(autouse=True)
def offline_quotes(monkeypatch):
    monkeypatch.setattr(holdings_api, "get_quote",
                        lambda t: {"price": 40.00, "day_change": 0.0, "day_change_pct": 0.0})


async def _ctx(db, basis=0):
    user = User(email="h@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    account = Account(user_id=user.id, account_type="brokerage",
                      display_name="Brokerage", currency="USD")
    security = Security(ticker="ACME", name="Acme Corp", type="stock")
    db.add_all([account, security])
    await db.flush()
    holding = Holding(account_id=account.id, security_id=security.id,
                      shares=Decimal("0"),
                      cost_basis_total=None if basis is None else Decimal(str(basis)))
    db.add(holding)
    await db.commit()
    return user, account, holding


async def _add_trade(db, user, account, holding, shares, price):
    return await holdings_api.create_trade(
        holding_id=holding.id,
        body=holdings_api.TradeCreate(
            trade_date=date(2026, 8, 15), action="buy",
            shares=shares, price_per_share=price,
        ),
        db=db, user=user, user_acct_ids=[account.id],
    )


async def test_a_priced_trade_sets_the_basis(db):
    """Baseline: 100 shares at $50."""
    user, account, holding = await _ctx(db)
    await _add_trade(db, user, account, holding, 100, 50.00)

    refreshed = await db.get(Holding, holding.id)
    await db.refresh(refreshed)
    assert float(refreshed.shares) == pytest.approx(100)
    assert float(refreshed.cost_basis_total) == pytest.approx(5000.0, abs=1)


async def test_saving_the_drawer_does_not_discard_a_derived_basis(db):
    """The bug this guards against.

    The drawer's form is filled from the holding when it opens and is not
    refilled after trades are saved, so "Save Changes" sends whatever the cost
    box held then — for a position created with the box empty, 0. Shares are
    already protected here because trades own them; the basis is derived from
    exactly the same trades and was not.

    Result on screen: 100 shares, a $5,000 trade in the history, and a
    Total Cost Basis of $0, with the entire $4,000 market value shown as
    gain.
    """
    user, account, holding = await _ctx(db)
    await _add_trade(db, user, account, holding, 100, 50.00)

    await holdings_api.update_holding(
        holding_id=holding.id,
        body=holdings_api.HoldingUpdate(cost_basis_total=0),
        db=db, user=user, user_acct_ids=[account.id],
    )

    refreshed = await db.get(Holding, holding.id)
    await db.refresh(refreshed)
    assert float(refreshed.cost_basis_total) == pytest.approx(5000.0, abs=1), (
        "a stale form field must not overwrite what the trades say"
    )


async def test_the_basis_is_still_editable_without_trades(db):
    """The guard is scoped to holdings whose trades own the number. A position
    with no trade history is the user's to type."""
    user, account, holding = await _ctx(db, basis=None)

    await holdings_api.update_holding(
        holding_id=holding.id,
        body=holdings_api.HoldingUpdate(cost_basis_total=1234.56),
        db=db, user=user, user_acct_ids=[account.id],
    )

    refreshed = await db.get(Holding, holding.id)
    await db.refresh(refreshed)
    assert float(refreshed.cost_basis_total) == pytest.approx(1234.56)


async def test_the_repair_task_recomputes_a_clobbered_basis(db, monkeypatch):
    """The rows already written before the guard existed.

    Migration 0025 nulls a zero basis only where *no* acquisition was priced,
    which is the right rule for a position nobody costed — and the wrong one
    here: this position has a priced buy, so its basis is not unknown, it is
    recoverable. Recomputing from the trades is the repair.
    """
    from app.modules.investments.activity import recalc_holding

    user, account, holding = await _ctx(db)
    await _add_trade(db, user, account, holding, 100, 50.00)

    # Put it back in the broken state the bug produced.
    clobbered = await db.get(Holding, holding.id)
    clobbered.cost_basis_total = Decimal("0")
    await db.commit()

    await recalc_holding(holding.id, db)
    await db.commit()

    repaired = await db.get(Holding, holding.id)
    await db.refresh(repaired)
    assert float(repaired.cost_basis_total) == pytest.approx(5000.0, abs=1)


async def test_the_repair_is_idempotent(db):
    """It recomputes from the trades either way, so a second run is a no-op."""
    from app.modules.investments.activity import recalc_holding

    user, account, holding = await _ctx(db)
    await _add_trade(db, user, account, holding, 100, 50.00)

    await recalc_holding(holding.id, db)
    await db.commit()
    first = (await db.get(Holding, holding.id)).cost_basis_total

    await recalc_holding(holding.id, db)
    await db.commit()
    second = (await db.get(Holding, holding.id)).cost_basis_total
    assert first == second


async def test_a_manual_holding_still_replays_normally(db):
    """A hand-built holding is derived from its trades, which is the whole
    point of trade history."""
    user, account, holding = await _ctx(db)
    await _add_trade(db, user, account, holding, 100, 50.00)

    refreshed = await db.get(Holding, holding.id)
    await db.refresh(refreshed)
    assert float(refreshed.shares) == pytest.approx(100)


# ── A sold position is not a holding ────────────────────────────────────────

async def test_a_sold_out_position_is_not_listed(db, monkeypatch):
    """Selling out zeroes a position rather than deleting it, so its cost
    basis stays. That is right for storage and wrong for the table: a $0 row for stock sold two years ago sat beside
    what the user actually owns.
    """
    from app.api.holdings import list_holdings
    from fastapi import BackgroundTasks

    monkeypatch.setattr(positions, "get_quotes_cached",
                        lambda tickers: {t: {"price": 0.0, "day_change": 0.0,
                                             "day_change_pct": 0.0, "is_stale": False}
                                         for t in tickers})

    user, account, holding = await _ctx(db)
    sold = Security(ticker="TSLA", name="Tesla Inc", type="stock")
    db.add(sold)
    await db.flush()
    db.add(Holding(account_id=account.id, security_id=sold.id,
                   shares=Decimal("0"), cost_basis_total=Decimal("4200")))
    live = await db.get(Holding, holding.id)
    live.shares = Decimal("10")
    live.cost_basis_total = Decimal("250")
    await db.commit()

    rows = await list_holdings(BackgroundTasks(), db, user, [account.id])
    tickers = {r["ticker"] for r in rows if r["id"] > 0}
    assert "TSLA" not in tickers, "a zeroed position is not a holding"
    assert "ACME" in tickers

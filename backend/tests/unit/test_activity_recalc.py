"""Unit tests for the ordered trade replay (shares + cost basis + income).

Pure-function tests over replay_trades/shares_on_date plus one DB-backed
recalc_holding round-trip against in-memory SQLite. No network anywhere.
"""
from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.holding import Holding
from app.models.trade import Trade
from app.modules.investments.activity import recalc_holding, replay_trades, shares_on_date

pytestmark = pytest.mark.unit


def t(action, day, shares=0, price=None, amount=None, ratio=None):
    return SimpleNamespace(
        action=action,
        trade_date=date(2024, 1, day),
        shares=shares,
        price_per_share=price,
        amount=amount,
        split_ratio=ratio,
    )


# ── Buy/sell parity with the old average-cost behavior ──────────────────────

def test_buys_then_sell_matches_average_cost():
    # Old behavior: avg = 3000/20 = 150; sell 5 → 15 shares, basis 2250.
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("buy", 20, shares=10, price=200),
        t("sell", 25, shares=5),
    ])
    assert shares == pytest.approx(15)
    assert basis == pytest.approx(2250)


def test_a_partly_priced_history_reports_no_basis_at_all():
    """A basis missing half its lots is not a smaller basis, it is a wrong one.

    This used to return 1000 — the priced lot only — on the reasoning that
    understating is safer than inventing. For the tax engine that holds, and it
    warns about the gap separately. For the holdings table it does not:
    understating basis *is* inventing a gain, and reporting $1,000 of cost
    against a position that cost more shows a profit that was never made.

    None makes the caller say "—" instead of picking a number.
    """
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("buy", 20, shares=10),  # no price recorded
    ])
    assert shares == pytest.approx(20)
    assert basis is None


def test_a_fully_priced_history_still_reports_a_basis():
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("buy", 20, shares=10, price=120),
    ])
    assert shares == pytest.approx(20)
    assert basis == pytest.approx(2200)


def test_a_position_with_no_acquisitions_is_not_unknown():
    """Nothing was acquired, so zero is a fact rather than a gap."""
    shares, basis = replay_trades([])
    assert shares == 0
    assert basis == pytest.approx(0)


def test_oversell_floors_at_zero():
    shares, basis = replay_trades([
        t("buy", 10, shares=5, price=100),
        t("sell", 11, shares=10),
    ])
    assert shares == 0
    assert basis == 0


# ── Splits ───────────────────────────────────────────────────────────────────

def test_split_rescales_shares_not_basis():
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("split", 15, ratio=2),
        t("sell", 20, shares=5),
    ])
    # After split: 20 shares, basis 1000, avg 50. Sell 5 → 15 shares, 750.
    assert shares == pytest.approx(15)
    assert basis == pytest.approx(750)


def test_reverse_split():
    shares, _ = replay_trades([
        t("buy", 10, shares=100, price=10),
        t("split", 15, ratio=0.25),  # 1-for-4
    ])
    assert shares == pytest.approx(25)


def test_ordering_matters_split_before_vs_after_buy():
    before = replay_trades([
        t("split", 5, ratio=2),
        t("buy", 10, shares=10, price=100),
    ])
    after = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("split", 15, ratio=2),
    ])
    assert before[0] == pytest.approx(10)   # split of zero shares is a no-op
    assert after[0] == pytest.approx(20)


# ── Income actions ───────────────────────────────────────────────────────────

def test_cash_dividend_has_no_position_effect():
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("dividend", 15, amount=25),
        t("interest", 16, amount=5),
        t("capgain", 17, amount=12),
    ])
    assert shares == pytest.approx(10)
    assert basis == pytest.approx(1000)


def test_reinvest_adds_shares_and_basis():
    shares, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("reinvest", 15, shares=0.5, price=110, amount=55),
    ])
    assert shares == pytest.approx(10.5)
    assert basis == pytest.approx(1055)


def test_reinvest_falls_back_to_shares_times_price():
    _, basis = replay_trades([
        t("buy", 10, shares=10, price=100),
        t("reinvest", 15, shares=0.5, price=110),  # no amount recorded
    ])
    assert basis == pytest.approx(1055)


# ── shares_on_date ───────────────────────────────────────────────────────────

def test_shares_on_date_respects_cutoff():
    trades = [
        t("buy", 10, shares=10, price=100),
        t("split", 15, ratio=2),
        t("sell", 20, shares=5),
    ]
    assert shares_on_date(trades, date(2024, 1, 12)) == pytest.approx(10)
    assert shares_on_date(trades, date(2024, 1, 16)) == pytest.approx(20)
    assert shares_on_date(trades, date(2024, 1, 25)) == pytest.approx(15)
    assert shares_on_date(trades, date(2024, 1, 1)) == 0


# ── DB round-trip ────────────────────────────────────────────────────────────

async def test_recalc_holding_persists():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSession(engine, expire_on_commit=False) as db:
        holding = Holding(account_id=1, security_id=1, shares=0, cost_basis_total=0)
        db.add(holding)
        await db.flush()
        db.add_all([
            Trade(holding_id=holding.id, trade_date=date(2024, 1, 10),
                  action="buy", shares=10, price_per_share=100),
            Trade(holding_id=holding.id, trade_date=date(2024, 1, 15),
                  action="split", shares=0, split_ratio=2),
            Trade(holding_id=holding.id, trade_date=date(2024, 1, 20),
                  action="reinvest", shares=1, price_per_share=55, amount=55),
        ])
        await db.flush()

        await recalc_holding(holding.id, db)
        await db.commit()

        h = await db.scalar(select(Holding).where(Holding.id == holding.id))
        assert float(h.shares) == pytest.approx(21)
        assert float(h.cost_basis_total) == pytest.approx(1055)

    await engine.dispose()


# ── Transfers move the position ─────────────────────────────────────────────
#
# These fell through the if/elif chain silently before the actions existed, so
# a transferred position kept its old share count forever.

def test_transfer_in_adds_shares_and_basis_like_a_buy():
    shares, basis = replay_trades([
        t("transfer_in", 5, shares=10, price=25),
    ])
    assert shares == pytest.approx(10)
    assert basis == pytest.approx(250)


def test_transfer_out_removes_shares_at_average_cost():
    shares, basis = replay_trades([
        t("buy", 1, shares=10, price=100),
        t("transfer_out", 5, shares=4),
    ])
    assert shares == pytest.approx(6)
    assert basis == pytest.approx(600), "average cost preserved on the remainder"


def test_transfer_in_without_a_price_leaves_the_basis_unknown():
    """Shares arrived and nobody said what they cost. That is a gap, and it is
    reported as one rather than as a cost of zero."""
    shares, basis = replay_trades([t("transfer_in", 5, shares=10)])
    assert shares == pytest.approx(10)
    assert basis is None


def test_transferring_everything_out_leaves_a_flat_position():
    shares, basis = replay_trades([
        t("buy", 1, shares=10, price=100),
        t("transfer_out", 5, shares=10),
    ])
    assert shares == pytest.approx(0)
    assert basis == pytest.approx(0)


def test_a_fee_leaves_the_position_untouched():
    shares, basis = replay_trades([
        t("buy", 1, shares=10, price=100),
        t("fee", 3, shares=0, amount=-9.99),
    ])
    assert shares == pytest.approx(10)
    assert basis == pytest.approx(1000)


def test_shares_on_date_sees_a_transfer():
    trades = [
        t("buy", 1, shares=10, price=100),
        t("transfer_out", 10, shares=6),
    ]
    assert shares_on_date(trades, date(2024, 1, 5)) == pytest.approx(10)
    assert shares_on_date(trades, date(2024, 1, 15)) == pytest.approx(4)


# ── "Unknown" has to be expressible ─────────────────────────────────────────

def test_the_update_schema_can_carry_an_explicit_null():
    """`exclude_none` versus `exclude_unset` is the whole bug.

    The update endpoint dropped nulls, so "nobody recorded what this cost" could
    not be sent at all — the form's only way to clear the field was 0, which
    means "it cost nothing", and the table then reported the entire market value
    as gain. `exclude_unset` keeps an explicitly-sent null while still leaving
    fields the client never mentioned alone.
    """
    from app.api.holdings import HoldingUpdate

    cleared = HoldingUpdate(cost_basis_total=None)
    assert "cost_basis_total" in cleared.model_dump(exclude_unset=True)
    assert cleared.model_dump(exclude_unset=True)["cost_basis_total"] is None

    untouched = HoldingUpdate(shares=10)
    assert "cost_basis_total" not in untouched.model_dump(exclude_unset=True)

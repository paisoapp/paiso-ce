"""Unit tests for dividend suggestions: shares-held math, the already-recorded
dedupe window, the no-trade-history guard, and the confirm flow. Calls the
endpoint functions directly against in-memory SQLite — no server, no network.
"""
from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.holding import Holding
from app.models.security import Security, SecurityDividend
from app.models.settings import UserSettings
from app.models.trade import Trade
from app.api.investment_income import (
    SuggestionConfirm,
    SuggestionConfirmBody,
    confirm_dividend_suggestions,
    dividend_suggestions,
    refresh_holding_dividends,
)

pytestmark = pytest.mark.unit

USER = SimpleNamespace(id=1)
ACCT_IDS = [1]


async def _db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    db = AsyncSession(engine, expire_on_commit=False)
    # Feature opt-in for user 1 (server gate defaults to enabled)
    db.add(UserSettings(user_id=1))
    sec = Security(ticker="DIVX", name="Dividend Fund", type="etf")
    db.add(sec)
    await db.flush()
    holding = Holding(account_id=1, security_id=sec.id, shares=0, cost_basis_total=0)
    db.add(holding)
    await db.flush()
    return engine, db, sec, holding


async def test_suggestions_math_and_dedupe():
    engine, db, sec, holding = await _db()
    db.add_all([
        Trade(holding_id=holding.id, trade_date=date(2024, 1, 10),
              action="buy", shares=10, price_per_share=100),
        SecurityDividend(security_id=sec.id, ex_date=date(2024, 2, 1), amount_per_share=0.5, price_hint=105.0),
        # No price_hint stored (e.g. synced before this column existed) — must fall back to None, not error
        SecurityDividend(security_id=sec.id, ex_date=date(2024, 5, 1), amount_per_share=0.6),
        # Ex-date before the first buy — no shares held, must be omitted
        SecurityDividend(security_id=sec.id, ex_date=date(2023, 11, 1), amount_per_share=0.4),
    ])
    await db.flush()

    out = await dividend_suggestions(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    s = out["suggestions"]
    assert [x["ex_date"] for x in s] == ["2024-05-01", "2024-02-01"]
    assert s[1]["total"] == pytest.approx(5.0)   # 10 shares × 0.50
    assert s[1]["price_hint"] == pytest.approx(105.0)
    assert s[0]["price_hint"] is None
    assert all(not x["already_recorded"] for x in s)

    # Record a dividend 3 days after the Feb ex-date → within the ±5d window
    db.add(Trade(holding_id=holding.id, trade_date=date(2024, 2, 4),
                 action="dividend", shares=0, amount=5.0))
    await db.flush()
    out = await dividend_suggestions(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    by_date = {x["ex_date"]: x for x in out["suggestions"]}
    assert by_date["2024-02-01"]["already_recorded"] is True
    assert by_date["2024-05-01"]["already_recorded"] is False

    await db.close(); await engine.dispose()


async def test_no_trade_history_reason():
    engine, db, sec, holding = await _db()
    db.add(SecurityDividend(security_id=sec.id, ex_date=date(2024, 2, 1), amount_per_share=0.5))
    await db.flush()

    out = await dividend_suggestions(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    assert out == {"suggestions": [], "reason": "no_trade_history"}

    await db.close(); await engine.dispose()


async def test_refresh_dividends_syncs_then_cooldown(monkeypatch):
    engine, db, sec, holding = await _db()
    db.add(Trade(holding_id=holding.id, trade_date=date(2024, 1, 10),
                 action="buy", shares=10, price_per_share=100))
    await db.flush()

    calls = {"n": 0}

    def fake_history(ticker):
        calls["n"] += 1
        return [(date(2024, 2, 1), 0.5, 105.0), (date(2024, 5, 1), 0.6, 110.0)]

    monkeypatch.setattr("app.api.investment_income.get_dividend_history", fake_history)

    out = await refresh_holding_dividends(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    assert out["refreshed"] is True
    assert out["rows"] == 2
    assert calls["n"] == 1
    # Rows landed and are visible as suggestions
    sugg = await dividend_suggestions(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    assert len(sugg["suggestions"]) == 2

    # Second call within the cooldown: no network hit, reported as up to date
    out2 = await refresh_holding_dividends(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    assert out2["refreshed"] is False
    assert out2["reason"] == "recently_synced"
    assert calls["n"] == 1  # get_dividend_history not called again

    await db.close(); await engine.dispose()


async def test_refresh_dividends_rejects_tickerless_holding():
    from fastapi import HTTPException

    engine, db, _sec, _holding = await _db()
    custom = Security(ticker=None, name="Custom Fund", type="custom")
    db.add(custom)
    await db.flush()
    holding = Holding(account_id=1, security_id=custom.id, shares=0, cost_basis_total=0)
    db.add(holding)
    await db.flush()

    with pytest.raises(HTTPException) as exc:
        await refresh_holding_dividends(holding.id, db=db, user=USER, user_acct_ids=ACCT_IDS)
    assert exc.value.status_code == 400

    await db.close(); await engine.dispose()


async def test_confirm_creates_trades_and_recalcs():
    engine, db, sec, holding = await _db()
    db.add(Trade(holding_id=holding.id, trade_date=date(2024, 1, 10),
                 action="buy", shares=10, price_per_share=100))
    await db.flush()

    body = SuggestionConfirmBody(confirmations=[
        SuggestionConfirm(ex_date=date(2024, 2, 1), action="dividend", amount=5.0),
        SuggestionConfirm(ex_date=date(2024, 5, 1), action="reinvest", amount=6.0,
                          shares=0.05, price_per_share=120),
    ])
    out = await confirm_dividend_suggestions(
        holding.id, body, db=db, user=USER, user_acct_ids=ACCT_IDS
    )
    assert out == {"created": 2}

    h = await db.get(Holding, holding.id)
    assert float(h.shares) == pytest.approx(10.05)
    assert float(h.cost_basis_total) == pytest.approx(1006.0)

    await db.close(); await engine.dispose()

"""Unit tests for the incremental daily-history coverage logic.

Pure logic (fetch planning, adjustment detection) plus DB-backed coverage
behavior against an in-memory SQLite with a mocked yfinance layer — the goal
is to prove the scheduled pass fetches only missing tails, request paths
no-op when covered, and split back-adjustments trigger a full refetch.
No network anywhere.
"""
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.security import IntradayPriceHistory, PriceHistory, Security
from app.modules.investments import backfill, market_data
from app.modules.investments.backfill import (
    ensure_daily_coverage,
    find_adjusted,
    get_daily_coverage,
    plan_daily_fetch,
    upsert_intraday,
    upsert_price_history,
)

pytestmark = pytest.mark.unit

TODAY = date.today()


@pytest.fixture(autouse=True)
def _reset_head_memo():
    backfill._head_attempted.clear()
    yield
    backfill._head_attempted.clear()


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


class FakeFetcher:
    """Stands in for market_data.get_daily_bulk; records every call."""

    def __init__(self, series: dict[str, list[dict]] | None = None):
        self.series = series or {}
        self.calls: list[dict] = []

    def __call__(self, symbols, *, start=None, end=None, period=None):
        self.calls.append({"symbols": list(symbols), "start": start, "end": end})
        out = {}
        for sym in symbols:
            rows = self.series.get(sym, [])
            out[sym] = [
                r for r in rows
                if (start is None or date.fromisoformat(r["date"]) >= start)
                and (end is None or date.fromisoformat(r["date"]) < end)  # end exclusive
            ]
        return out


def daily_series(symbol_close: float, start: date, end: date, bump: dict[date, float] | None = None):
    """Weekday closes from start..end inclusive at a flat price (plus bumps)."""
    rows, d = [], start
    while d <= end:
        if d.weekday() < 5:
            rows.append({"date": d.isoformat(), "close": (bump or {}).get(d, symbol_close), "volume": 0})
        d += timedelta(days=1)
    return rows


async def seed_history(db, sec_id: int, start: date, end: date, close: float = 100.0):
    rows = [
        {"security_id": sec_id, "as_of": date.fromisoformat(r["date"]), "close": r["close"]}
        for r in daily_series(close, start, end)
    ]
    await upsert_price_history(db, rows)
    await db.commit()
    return len(rows)


# ── plan_daily_fetch (pure) ──────────────────────────────────────────────────

def test_plan_empty_history_gets_full_lookback():
    buckets = plan_daily_fetch({1: None}, TODAY)
    assert buckets == {TODAY - timedelta(days=365): [1]}


def test_plan_fresh_history_gets_short_tail():
    buckets = plan_daily_fetch({1: TODAY - timedelta(days=1)}, TODAY)
    assert buckets == {TODAY - timedelta(days=6): [1]}


def test_plan_downtime_gap_starts_at_gap():
    last = TODAY - timedelta(days=14)
    buckets = plan_daily_fetch({1: last}, TODAY)
    assert buckets == {last - timedelta(days=5): [1]}


def test_plan_stale_beyond_lookback_is_full_backfill():
    buckets = plan_daily_fetch({1: TODAY - timedelta(days=400)}, TODAY)
    assert buckets == {TODAY - timedelta(days=365): [1]}


def test_plan_buckets_shared_windows_together():
    yesterday = TODAY - timedelta(days=1)
    buckets = plan_daily_fetch({1: yesterday, 2: yesterday, 3: None}, TODAY)
    assert sorted(buckets[TODAY - timedelta(days=6)]) == [1, 2]
    assert buckets[TODAY - timedelta(days=365)] == [3]


# ── find_adjusted (pure) ─────────────────────────────────────────────────────

def test_adjustment_detected_beyond_tolerance():
    d = TODAY - timedelta(days=3)
    fetched = {1: [{"date": d.isoformat(), "close": 50.0}]}   # 2:1 split re-basing
    stored = {(1, d): 100.0}
    assert find_adjusted(fetched, stored) == {1}


def test_no_adjustment_within_tolerance():
    d = TODAY - timedelta(days=3)
    fetched = {1: [{"date": d.isoformat(), "close": 100.2}]}
    stored = {(1, d): 100.0}
    assert find_adjusted(fetched, stored) == set()


def test_todays_live_row_never_counts_as_adjustment():
    # Today's stored row is the live quote; it legitimately drifts from the
    # download's official close intraday.
    fetched = {1: [{"date": TODAY.isoformat(), "close": 90.0}]}
    stored = {(1, TODAY): 100.0}
    assert find_adjusted(fetched, stored) == set()


# ── ensure_daily_coverage against the DB ─────────────────────────────────────

async def make_security(db, ticker="AAPL") -> Security:
    sec = Security(ticker=ticker, name=ticker, type="stock")
    db.add(sec)
    await db.commit()
    return sec


async def test_new_security_full_backfill(db, monkeypatch):
    sec = await make_security(db)
    full_start = TODAY - timedelta(days=365)
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, full_start, TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    written = await ensure_daily_coverage(db, [sec])
    await db.commit()

    assert len(fetcher.calls) == 1
    assert fetcher.calls[0]["start"] == full_start
    assert written > 200  # ~a year of weekday closes
    mn, mx = (await get_daily_coverage(db, [sec.id]))[sec.id]
    assert mn is not None and mn <= full_start + timedelta(days=3)
    assert mx is not None and mx >= TODAY - timedelta(days=3)


async def test_covered_security_no_fetch_on_request_path(db, monkeypatch):
    sec = await make_security(db)
    await seed_history(db, sec.id, TODAY - timedelta(days=365), TODAY)
    fetcher = FakeFetcher()
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    written = await ensure_daily_coverage(db, [sec], refresh_tail=False)

    assert fetcher.calls == []
    assert written == 0


async def test_scheduled_pass_fetches_only_short_tail(db, monkeypatch):
    sec = await make_security(db)
    await seed_history(db, sec.id, TODAY - timedelta(days=365), TODAY - timedelta(days=1))
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, TODAY - timedelta(days=365), TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    _mn, last_stored = (await get_daily_coverage(db, [sec.id]))[sec.id]
    await ensure_daily_coverage(db, [sec])  # refresh_tail=True default

    assert len(fetcher.calls) == 1
    # tail starts a few days before the last stored close, not a year back
    assert fetcher.calls[0]["start"] == last_stored - timedelta(days=5)


async def test_downtime_gap_heals_from_gap_start(db, monkeypatch):
    sec = await make_security(db)
    last = TODAY - timedelta(days=14)
    await seed_history(db, sec.id, TODAY - timedelta(days=365), last)
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, TODAY - timedelta(days=365), TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    await ensure_daily_coverage(db, [sec])
    await db.commit()

    # daily_series only emits weekdays, so the stored history actually ends on
    # the last weekday ≤ `last` — the overlap window starts from there.
    last_stored = last
    while last_stored.weekday() >= 5:
        last_stored -= timedelta(days=1)
    assert fetcher.calls[0]["start"] == last_stored - timedelta(days=5)
    _mn, mx = (await get_daily_coverage(db, [sec.id]))[sec.id]
    assert mx >= TODAY - timedelta(days=3)  # gap filled to (about) today


async def test_head_extension_for_older_range(db, monkeypatch):
    sec = await make_security(db)
    await seed_history(db, sec.id, TODAY - timedelta(days=100), TODAY)
    # actual stored head lands on the first seeded weekday
    stored_min, _mx = (await get_daily_coverage(db, [sec.id]))[sec.id]
    prior_start = TODAY - timedelta(days=400)
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, prior_start, TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    written = await ensure_daily_coverage(db, [sec], start=prior_start, refresh_tail=False)
    await db.commit()

    assert written > 0
    assert len(fetcher.calls) == 1
    assert fetcher.calls[0]["start"] == prior_start
    assert fetcher.calls[0]["end"] == stored_min  # end exclusive, stops at stored head
    mn, _mx = (await get_daily_coverage(db, [sec.id]))[sec.id]
    assert mn <= prior_start + timedelta(days=3)


async def test_head_extension_not_retried_when_no_older_data(db, monkeypatch):
    # An IPO ticker has no bars before its listing date: the empty head fetch
    # must not repeat on every pass.
    sec = await make_security(db)
    listing = TODAY - timedelta(days=60)
    await seed_history(db, sec.id, listing, TODAY)
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, listing, TODAY)})  # nothing pre-listing
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    await ensure_daily_coverage(db, [sec], refresh_tail=False)
    first_calls = len(fetcher.calls)
    await ensure_daily_coverage(db, [sec], refresh_tail=False)

    assert first_calls == 1  # one attempted head fetch
    assert len(fetcher.calls) == first_calls  # no retry on the second pass


async def test_split_adjustment_triggers_full_refetch(db, monkeypatch):
    sec = await make_security(db)
    # Stored series at pre-split basis 100.0, through yesterday.
    await seed_history(db, sec.id, TODAY - timedelta(days=365), TODAY - timedelta(days=1), close=100.0)
    # Provider now returns everything re-based to 50.0 (2:1 split).
    fetcher = FakeFetcher({"AAPL": daily_series(50.0, TODAY - timedelta(days=365), TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    await ensure_daily_coverage(db, [sec])
    await db.commit()

    # Tail fetch detected the mismatch, then refetched the full lookback.
    assert len(fetcher.calls) == 2
    assert fetcher.calls[1]["start"] == TODAY - timedelta(days=365)
    closes = (await db.scalars(
        select(PriceHistory.close).where(
            PriceHistory.security_id == sec.id,
            PriceHistory.as_of < TODAY,
        )
    )).all()
    assert closes and all(float(c) == 50.0 for c in closes)  # old basis fully replaced


async def test_force_full_ignores_coverage(db, monkeypatch):
    sec = await make_security(db)
    await seed_history(db, sec.id, TODAY - timedelta(days=365), TODAY)
    fetcher = FakeFetcher({"AAPL": daily_series(100.0, TODAY - timedelta(days=365), TODAY)})
    monkeypatch.setattr(market_data, "get_daily_bulk", fetcher)

    await ensure_daily_coverage(db, [sec], force_full=True)

    assert len(fetcher.calls) == 1
    assert fetcher.calls[0]["start"] == TODAY - timedelta(days=365)


# ── upsert helpers ───────────────────────────────────────────────────────────

async def test_upsert_price_history_insert_then_update(db):
    sec = await make_security(db)
    d = TODAY - timedelta(days=2)
    await upsert_price_history(db, [{"security_id": sec.id, "as_of": d, "close": 100.0}])
    await upsert_price_history(db, [{"security_id": sec.id, "as_of": d, "close": 101.5}])
    await db.commit()

    rows = (await db.execute(
        select(PriceHistory.as_of, PriceHistory.close)
        .where(PriceHistory.security_id == sec.id)
    )).all()
    assert len(rows) == 1  # PK conflict updated, not duplicated
    assert float(rows[0][1]) == 101.5


async def test_upsert_intraday_insert_then_update(db):
    sec = await make_security(db)
    ts = datetime(TODAY.year, TODAY.month, TODAY.day, 14, 30)
    row = {"security_id": sec.id, "ts": ts, "interval": "1m", "close": 10.0}
    await upsert_intraday(db, [row])
    await upsert_intraday(db, [{**row, "close": 10.5}])
    await db.commit()

    rows = (await db.execute(
        select(IntradayPriceHistory.close).where(IntradayPriceHistory.security_id == sec.id)
    )).all()
    assert len(rows) == 1
    assert float(rows[0][0]) == 10.5


# ── retention (via refresh_and_persist) ──────────────────────────────────────

async def test_1h_retention_pruned_at_90_days(db, monkeypatch):
    from app.modules.investments import refresh as refresh_mod

    sec = await make_security(db)
    now = datetime.utcnow()
    await upsert_intraday(db, [
        {"security_id": sec.id, "ts": now - timedelta(days=89), "interval": "1h", "close": 1.0},
        {"security_id": sec.id, "ts": now - timedelta(days=91), "interval": "1h", "close": 1.0},
        {"security_id": sec.id, "ts": now - timedelta(days=6), "interval": "1m", "close": 1.0},
        {"security_id": sec.id, "ts": now - timedelta(days=8), "interval": "1m", "close": 1.0},
    ])
    await db.commit()

    # Neuter all network fetchers — this test only exercises the prune.
    monkeypatch.setattr(refresh_mod, "refresh_symbols", lambda symbols: {})
    monkeypatch.setattr(refresh_mod, "get_intraday_bulk", lambda symbols, interval="1m": {})
    monkeypatch.setattr(market_data, "get_daily_bulk", FakeFetcher())

    await refresh_mod.refresh_and_persist(db, [sec], include_history=True)

    kept = {
        (iv, round((now - ts).days))
        for iv, ts in (await db.execute(
            select(IntradayPriceHistory.interval, IntradayPriceHistory.ts)
            .where(IntradayPriceHistory.security_id == sec.id)
        )).all()
    }
    assert ("1h", 89) in kept
    assert ("1h", 91) not in kept
    assert ("1m", 6) in kept
    assert ("1m", 8) not in kept

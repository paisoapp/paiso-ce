"""Daily price-history coverage: incremental fetch planning + gap backfill.

The steady-state history refresh should never re-download a year of closes —
only the missing tail since the last stored bar (plus a small overlap used to
detect yfinance back-adjustments after splits/dividends). The same coverage
logic generically heals every gap case: a brand-new ticker, a fresh install,
a downtime gap, or a request needing older data than what is stored.
"""
import asyncio
import logging
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from app.core.upsert import dialect_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.security import IntradayPriceHistory, PriceHistory, Security
from app.modules.investments import market_data

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 365
TAIL_OVERLAP_DAYS = 5
# When the requested start predates stored coverage by more than this, extend
# the head. The grace absorbs weekends/holidays at the window edge.
HEAD_GRACE_DAYS = 7
# Stored vs refetched closes diverging more than this on an overlap day means
# yfinance has back-adjusted history (split/dividend, auto_adjust=True) and the
# stored series is on the old basis — refetch the full lookback for that symbol.
ADJUSTMENT_TOLERANCE = 0.005

# Earliest start we already head-fetched per security, so short-history
# tickers (e.g. recent IPOs, where yfinance simply has no older bars) don't
# trigger an empty refetch on every pass. In-process only — a restart just
# costs one redundant fetch.
_head_attempted: dict[int, date] = {}


def prev_trading_day(today: date) -> date:
    """The weekday before `today` (holidays not modelled, matching refresh.py)."""
    d = today - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def plan_daily_fetch(
    last_as_of: dict[int, date | None],
    today: date,
    *,
    lookback_days: int = LOOKBACK_DAYS,
    tail_overlap_days: int = TAIL_OVERLAP_DAYS,
) -> dict[date, list[int]]:
    """Group security_ids by required fetch-start date.

    Securities with no rows (or rows staler than the lookback) get a full
    backfill from ``today - lookback_days``; everything else gets an
    incremental tail from ``last_as_of - tail_overlap_days``. Bucketing by
    identical start date lets all tickers sharing a window share one
    yf.download call — the steady state is a single ~6-day bucket.
    """
    full_start = today - timedelta(days=lookback_days)
    buckets: dict[date, list[int]] = {}
    for sec_id, last in last_as_of.items():
        if last is None or last < full_start:
            start = full_start
        else:
            start = last - timedelta(days=tail_overlap_days)
        buckets.setdefault(start, []).append(sec_id)
    return buckets


async def get_daily_coverage(
    db: AsyncSession, sec_ids: list[int]
) -> dict[int, tuple[date | None, date | None]]:
    """(min(as_of), max(as_of)) per security_id from price_history."""
    out: dict[int, tuple[date | None, date | None]] = {sid: (None, None) for sid in sec_ids}
    if not sec_ids:
        return out
    rows = (await db.execute(
        select(
            PriceHistory.security_id,
            func.min(PriceHistory.as_of),
            func.max(PriceHistory.as_of),
        )
        .where(PriceHistory.security_id.in_(sec_ids))
        .group_by(PriceHistory.security_id)
    )).all()
    for sid, mn, mx in rows:
        out[sid] = (mn, mx)
    return out


async def upsert_price_history(db: AsyncSession, rows: list[dict]) -> int:
    """Bulk upsert into price_history. rows: {security_id, as_of, close}.

    One executemany statement instead of per-row db.merge (SELECT+UPDATE each)
    keeps the SQLite write transaction short.
    """
    if not rows:
        return 0
    stmt = dialect_insert(PriceHistory)
    stmt = stmt.on_conflict_do_update(
        index_elements=["security_id", "as_of"],
        set_={"close": stmt.excluded.close},
    )
    await db.execute(stmt, rows)
    return len(rows)


async def insert_price_history_if_missing(db: AsyncSession, rows: list[dict]) -> None:
    """Bulk insert that never overwrites existing rows (quote-derived seeds)."""
    if not rows:
        return
    stmt = dialect_insert(PriceHistory).on_conflict_do_nothing(
        index_elements=["security_id", "as_of"]
    )
    await db.execute(stmt, rows)


async def upsert_intraday(db: AsyncSession, rows: list[dict]) -> int:
    """Bulk upsert into intraday_price_history. rows: {security_id, ts, interval, close}."""
    if not rows:
        return 0
    stmt = dialect_insert(IntradayPriceHistory)
    stmt = stmt.on_conflict_do_update(
        index_elements=["security_id", "ts", "interval"],
        set_={"close": stmt.excluded.close},
    )
    await db.execute(stmt, rows)
    return len(rows)


def find_adjusted(
    fetched: dict[int, list[dict]],
    stored_closes: dict[tuple[int, date], float],
    *,
    tolerance: float = ADJUSTMENT_TOLERANCE,
) -> set[int]:
    """Security ids whose refetched overlap closes diverge from stored ones.

    A divergence means yfinance re-based the whole series (auto_adjust after a
    split/dividend), so the incremental tail can't just be appended — the full
    lookback must be refetched for that security. Today's row is exempt: it is
    continuously rewritten with the live quote, which legitimately drifts from
    the download's official close during the session.
    """
    adjusted: set[int] = set()
    today = date.today()
    for sid, rows in fetched.items():
        for row in rows:
            as_of = date.fromisoformat(row["date"])
            if as_of >= today:
                continue
            old = stored_closes.get((sid, as_of))
            if old and old > 0 and abs(row["close"] - old) / old > tolerance:
                adjusted.add(sid)
                break
    return adjusted


async def _stored_closes(
    db: AsyncSession, sec_ids: list[int], since: date
) -> dict[tuple[int, date], float]:
    rows = (await db.execute(
        select(PriceHistory.security_id, PriceHistory.as_of, PriceHistory.close)
        .where(PriceHistory.security_id.in_(sec_ids), PriceHistory.as_of >= since)
    )).all()
    return {(sid, as_of): float(close) for sid, as_of, close in rows if close is not None}


async def _fetch_daily(
    symbols: list[str], *, start: date, end: date | None = None
) -> dict[str, list[dict]]:
    """Run the blocking yfinance bulk download off the event loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(
        None, lambda: market_data.get_daily_bulk(symbols, start=start, end=end)
    )


def _to_rows(sid: int, rows: list[dict]) -> list[dict]:
    return [
        {"security_id": sid, "as_of": date.fromisoformat(r["date"]), "close": r["close"]}
        for r in rows
    ]


async def ensure_daily_coverage(
    db: AsyncSession,
    securities: list[Security],
    *,
    start: date | None = None,
    lookback_days: int = LOOKBACK_DAYS,
    force_full: bool = False,
    refresh_tail: bool = True,
) -> int:
    """Fetch and upsert only the daily closes that are missing.

    Handles all gap cases generically: new ticker (full lookback), downtime
    gap (tail from last stored date), and head extension when ``start`` — or,
    by default, the lookback window — predates stored coverage (e.g. a
    prior_year chart request, or a deploy where only quote-derived seed rows
    exist). Does not commit — callers own the transaction.

    ``refresh_tail=True`` (the scheduled pass) always re-fetches the last few
    days so today's official close lands and the split/adjustment overlap
    check runs. ``refresh_tail=False`` (request paths, e.g. charts) skips the
    fetch entirely when coverage already reaches the previous trading day, so
    a covered chart request costs one grouped query and no network.

    Returns the number of rows written.
    """
    secs = [s for s in securities if s.ticker and s.id is not None]
    if not secs:
        return 0

    today = date.today()
    full_start = today - timedelta(days=lookback_days)
    sec_by_id = {s.id: s for s in secs}
    coverage = await get_daily_coverage(db, list(sec_by_id))

    if force_full:
        buckets: dict[date, list[int]] = {min(start or full_start, full_start): list(sec_by_id)}
    else:
        buckets = plan_daily_fetch(
            {sid: mx for sid, (_, mx) in coverage.items()}, today,
            lookback_days=lookback_days,
        )
        if not refresh_tail:
            # Request path: coverage through the previous trading day is
            # enough (today's bar is still forming / continuously seeded by
            # the quote pass) — drop those securities from the fetch.
            fresh_cutoff = prev_trading_day(today)
            for bucket_start in list(buckets):
                remaining = [
                    sid for sid in buckets[bucket_start]
                    if coverage[sid][1] is None or coverage[sid][1] < fresh_cutoff
                ]
                if remaining:
                    buckets[bucket_start] = remaining
                else:
                    del buckets[bucket_start]
        if start is not None and start < full_start:
            # Empty securities with an explicit older range (e.g. prior_year):
            # widen their full backfill to the requested start in one go.
            empty = [
                sid for sid in buckets.get(full_start, [])
                if coverage[sid][0] is None
            ]
            if empty:
                buckets[full_start] = [sid for sid in buckets[full_start] if sid not in empty]
                if not buckets[full_start]:
                    del buckets[full_start]
                buckets.setdefault(start, []).extend(empty)

    rows_written = 0
    needs_full: set[int] = set()

    # Tail / full fetches, one bulk download per distinct start date.
    for bucket_start in sorted(buckets):
        sid_list = buckets[bucket_start]
        symbols = [sec_by_id[sid].ticker for sid in sid_list]
        data = await _fetch_daily(symbols, start=bucket_start)
        fetched = {sid: data.get(sec_by_id[sid].ticker, []) for sid in sid_list}
        if not force_full:
            stored = await _stored_closes(db, sid_list, since=bucket_start)
            needs_full |= find_adjusted(fetched, stored)
        for sid, rows in fetched.items():
            if sid in needs_full:
                continue
            rows_written += await upsert_price_history(db, _to_rows(sid, rows))

    # Head extension: required range predates stored coverage. Defaults to the
    # lookback window so partially-covered securities (e.g. only quote-seeded
    # rows after a fresh deploy) self-heal to a full year of history.
    if not force_full:
        head_target = start if start is not None else full_start
        head: dict[date, list[int]] = {}
        for sid, (mn, _mx) in coverage.items():
            if sid in needs_full or mn is None:
                continue
            if head_target < mn - timedelta(days=HEAD_GRACE_DAYS):
                tried = _head_attempted.get(sid)
                if tried is not None and tried <= head_target:
                    continue  # already fetched at least this far back — nothing there
                head.setdefault(mn, []).append(sid)
        for mn, sid_list in head.items():
            symbols = [sec_by_id[sid].ticker for sid in sid_list]
            data = await _fetch_daily(symbols, start=head_target, end=mn)  # end exclusive
            for sid in sid_list:
                _head_attempted[sid] = head_target
                rows_written += await upsert_price_history(
                    db, _to_rows(sid, data.get(sec_by_id[sid].ticker, []))
                )

    # Back-adjusted securities: refetch the whole lookback so the stored
    # series is on the same basis as the new bars.
    if needs_full:
        refetch_start = min(start or full_start, full_start)
        symbols = [sec_by_id[sid].ticker for sid in needs_full]
        log.info("detected back-adjusted history, full refetch: %s", symbols)
        data = await _fetch_daily(symbols, start=refetch_start)
        for sid in needs_full:
            rows_written += await upsert_price_history(
                db, _to_rows(sid, data.get(sec_by_id[sid].ticker, []))
            )

    return rows_written


async def backfill_new_security(security_id: int) -> None:
    """Immediate history backfill for a just-created Security.

    Scheduled via FastAPI BackgroundTasks from POST /api/holdings so charts
    work seconds after a holding is added instead of waiting for the next
    10-minute history pass. Opens its own session (never reuse the request's)
    and swallows all errors — the periodic pass self-heals anything missed.
    """
    try:
        from app.core.database import AsyncSessionLocal
        import app.models  # noqa: F401 — ensure ORM mappers are registered

        async with AsyncSessionLocal() as db:
            sec = await db.get(Security, security_id)
            if sec is None or not sec.ticker:
                return
            symbol = sec.ticker

            loop = asyncio.get_running_loop()
            _quote, intraday_1m, intraday_1h = await asyncio.gather(
                loop.run_in_executor(None, market_data.get_quote, symbol),
                loop.run_in_executor(None, market_data.get_intraday_bulk, [symbol], "1m"),
                loop.run_in_executor(None, market_data.get_intraday_bulk, [symbol], "1h"),
            )

            written = await ensure_daily_coverage(db, [sec])

            intraday_rows = []
            for interval, data in (("1m", intraday_1m), ("1h", intraday_1h)):
                for row in data.get(symbol, []):
                    try:
                        ts = datetime.fromisoformat(row["ts"])
                    except ValueError:
                        continue
                    intraday_rows.append({
                        "security_id": sec.id, "ts": ts,
                        "interval": interval, "close": row["close"],
                    })
            await upsert_intraday(db, intraday_rows)

            # Dividend history too, so the "Detected dividends" panel is populated
            # the moment a dividend-paying ticker is added — no waiting on the
            # weekly job. Failures here never block the price backfill.
            try:
                from app.modules.investments.dividends import upsert_dividends
                divs = await loop.run_in_executor(
                    None, market_data.get_dividend_history, symbol
                )
                await upsert_dividends(db, sec, divs)
            except Exception:
                log.warning("dividend backfill for %s failed", symbol, exc_info=True)

            await db.commit()
            log.info(
                "backfilled new security %s (%s): %d daily rows, %d intraday bars",
                security_id, symbol, written, len(intraday_rows),
            )
    except Exception:
        log.warning("backfill_new_security(%s) failed", security_id, exc_info=True)

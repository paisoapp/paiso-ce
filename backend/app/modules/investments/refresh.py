"""Shared market-data refresh + persistence.

Used by both the on-demand endpoint (POST /api/market/refresh) and the
scheduled job (refresh_all_market_data). The DB is the source of truth for
prices; the read path (get_quotes_cached) never hits the network.
"""
import asyncio
from datetime import date, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.security import IntradayPriceHistory, PriceHistory, Security
from app.modules.investments.backfill import (
    ensure_daily_coverage,
    insert_price_history_if_missing,
    upsert_intraday,
    upsert_price_history,
)
from app.modules.investments.market_data import (
    get_intraday_bulk,
    refresh_symbols,
)


def market_today(now: datetime | None = None) -> date:
    """Today's date on the US market's clock (America/New_York).

    The servers run in UTC, so ``date.today()`` turns over at 7-8pm Eastern,
    while the session that just closed is still "today" to every user. Daily
    closes and the day-change baseline are both keyed on this date.
    """
    import zoneinfo

    tz = zoneinfo.ZoneInfo("America/New_York")
    et = now or datetime.now(tz=tz)
    if et.tzinfo is None:
        et = et.replace(tzinfo=tz)
    return et.astimezone(tz).date()


def trades_weekends(ticker: str | None, security_type: str | None = None) -> bool:
    """True for a symbol that has daily closes on Saturdays and Sundays (crypto).

    Yahoo spells crypto pairs ``BTC-USD``; a manual holding may carry that
    symbol with a generic type, so the ticker decides as much as the type.
    """
    return security_type == "crypto" or bool(ticker and ticker.upper().endswith("-USD"))


def is_market_open(now: datetime | None = None) -> bool:
    """True during US regular trading hours (Mon–Fri, 09:30–16:00 ET).

    Holidays are not modelled — a handful of no-op refreshes a year is cheaper
    than maintaining a holiday calendar. Mirrors the frontend isMarketOpen().
    """
    import zoneinfo

    et = (now or datetime.now(tz=zoneinfo.ZoneInfo("America/New_York")))
    if et.tzinfo is None:
        et = et.replace(tzinfo=zoneinfo.ZoneInfo("America/New_York"))
    et = et.astimezone(zoneinfo.ZoneInfo("America/New_York"))
    if et.weekday() >= 5:  # 5 = Sat, 6 = Sun
        return False
    minutes = et.hour * 60 + et.minute
    return 9 * 60 + 30 <= minutes < 16 * 60


def _quote_session(quote: dict, today: date, weekends: bool) -> date | None:
    """The trading date a quote's regular price belongs to, or None when it
    cannot be told (then nothing is written for it)."""
    raw = quote.get("market_date")
    if raw:
        try:
            session = date.fromisoformat(str(raw))
        except ValueError:
            session = None
        if session is not None and session <= today:
            return session
    # No session date on the quote: only today's own session is safe to claim,
    # and only once it has opened.
    if weekends:
        return today
    return today if is_market_open() else None


async def prune_stray_closes(
    db: AsyncSession, securities: list[Security], *, since: date | None = None,
) -> int:
    """Delete daily closes no session produced: dated after today, or on a
    weekend for a symbol that does not trade then. ``since`` limits the scan
    to recent rows (the frequent pass); the weekly pass scans everything.

    Off-hours refreshes used to write them under the server's UTC date, each a
    copy of the previous session's close. Left in place they read as a flat
    session, zeroing the day change every weekend.
    """
    today = market_today()
    weekday_only = {s.id for s in securities if s.ticker and not trades_weekends(s.ticker, s.type)}
    ids = [s.id for s in securities if s.ticker]
    if not ids:
        return 0
    query = select(PriceHistory.security_id, PriceHistory.as_of).where(PriceHistory.security_id.in_(ids))
    if since is not None:
        query = query.where(PriceHistory.as_of >= since)
    stray: dict[int, list[date]] = {}
    for sec_id, as_of in (await db.execute(query)).all():
        if as_of > today or (as_of.weekday() >= 5 and sec_id in weekday_only):
            stray.setdefault(sec_id, []).append(as_of)
    for sec_id, dates in stray.items():
        await db.execute(delete(PriceHistory).where(
            PriceHistory.security_id == sec_id, PriceHistory.as_of.in_(dates),
        ))
    return sum(len(d) for d in stray.values())


async def refresh_and_persist(
    db: AsyncSession,
    securities: list[Security],
    *,
    include_history: bool = True,
) -> int:
    """Fetch live quotes + intraday/daily data for `securities` and persist.

    Returns the number of symbols refreshed. Always persists (the live 60-second
    pass):
      - 1-minute intraday bars (incrementally) — the live "Today" view
      - today's live quote price into price_history (as_of = today) so the API,
        in a separate process, serves it without a network call

    When ``include_history`` is True (the default, and the ~10-minute pass), it
    also fetches+persists data that only changes slowly, so the 60-second pass
    doesn't re-download a year of history every minute:
      - daily closes into price_history — incrementally: only the missing tail
        since the last stored bar (plus a small overlap that detects yfinance
        back-adjustments), never a full year re-download
      - 1-hour intraday bars (back the multi-day intraday view)
    """
    symbols = [s.ticker for s in securities if s.ticker]
    if not symbols:
        return 0

    loop = asyncio.get_running_loop()
    fetches = [
        loop.run_in_executor(None, refresh_symbols, symbols),
        loop.run_in_executor(None, get_intraday_bulk, symbols, "1m"),
    ]
    if include_history:
        fetches += [
            loop.run_in_executor(None, get_intraday_bulk, symbols, "1h"),
        ]
    gathered = await asyncio.gather(*fetches)
    results, intraday_1m = gathered[0], gathered[1]
    intraday_1h = gathered[2] if include_history else {}

    sec_by_ticker = {s.ticker: s for s in securities if s.ticker}
    sec_ids = [s.id for s in securities if s.ticker]

    # Daily price history — only on the history pass; daily closes change once
    # a day. Coverage-aware: fetches only what's missing per security.
    if include_history:
        await ensure_daily_coverage(db, list(securities))
        await prune_stray_closes(db, list(securities), since=market_today() - timedelta(days=14))

    # Intraday bars. Persist incrementally: yfinance returns the whole window on
    # every call, but only bars at/after the latest stored timestamp can be new or
    # still-forming, so we skip the rest. 1m runs every pass; 1h only on the
    # history pass.
    interval_data = [("1m", intraday_1m)]
    if include_history:
        interval_data.append(("1h", intraday_1h))
    persist_intervals = tuple(label for label, _ in interval_data)

    latest_ts: dict[tuple[int, str], datetime] = {}
    if sec_ids:
        for sid, iv, mx in (await db.execute(
            select(
                IntradayPriceHistory.security_id,
                IntradayPriceHistory.interval,
                func.max(IntradayPriceHistory.ts),
            )
            .where(
                IntradayPriceHistory.security_id.in_(sec_ids),
                IntradayPriceHistory.interval.in_(persist_intervals),
            )
            .group_by(IntradayPriceHistory.security_id, IntradayPriceHistory.interval)
        )).all():
            latest_ts[(sid, iv)] = mx

    intraday_rows: list[dict] = []
    for interval_label, intraday_data in interval_data:
        for ticker, sec in sec_by_ticker.items():
            cutoff_ts = latest_ts.get((sec.id, interval_label))
            for row in intraday_data.get(ticker, []):
                try:
                    ts = datetime.fromisoformat(row["ts"])
                except ValueError:
                    continue
                if cutoff_ts is not None and ts < cutoff_ts:
                    continue  # already stored on an earlier run
                intraday_rows.append({
                    "security_id": sec.id,
                    "ts": ts,
                    "interval": interval_label,
                    "close": row["close"],
                })
    await upsert_intraday(db, intraday_rows)

    # The live price as the latest daily point. Use the regular-session close
    # (regular_price) when available so the DB always stores the official close
    # rather than any extended-hours price that the quote may carry.
    #
    # The row is dated by the session the quote belongs to, not by the server's
    # clock. POST /market/refresh runs at any hour, and dating its row with the
    # UTC date wrote Monday's close as Tuesday's after 7pm Central, so the day
    # change compared the close against itself and showed $0 on every row. A
    # pre-open or weekend refresh likewise must not invent a session.
    today = market_today()

    today_rows: list[dict] = []
    seed_rows: list[dict] = []
    for ticker, sec in sec_by_ticker.items():
        q = results.get(ticker) or {}
        session = _quote_session(q, today, trades_weekends(ticker, sec.type))
        if session is None:
            continue
        price = float(q.get("regular_price") or q.get("price") or 0.0)
        if price > 0:
            today_rows.append({"security_id": sec.id, "as_of": session, "close": price})

        # Previous trading day: walk back over weekends (holidays not modelled).
        prev_trading_day = session - timedelta(days=1)
        if not trades_weekends(ticker, sec.type):
            while prev_trading_day.weekday() >= 5:
                prev_trading_day -= timedelta(days=1)

        # Seed yesterday's close so db_prev_close always resolves on fresh
        # deploys before the daily-history backfill has run.
        # day_change = regular_price - regular_day_change = yesterday's close.
        reg_price = float(q.get("regular_price") or 0.0)
        reg_change = q.get("day_change")  # regularMarketChange after Stage 2/3
        if reg_price > 0 and reg_change is not None:
            prev_close_val = reg_price - float(reg_change)
            if prev_close_val > 0:
                seed_rows.append({
                    "security_id": sec.id,
                    "as_of": prev_trading_day,
                    "close": prev_close_val,
                })
    await upsert_price_history(db, today_rows)
    # Seeds never overwrite real history (insert-if-missing).
    await insert_price_history_if_missing(db, seed_rows)

    # Retention: cap the intraday table. The 1m prune is a cheap single delete, safe
    # every pass; the 1h prune + legacy-5m cleanup ride on the history pass.
    now = datetime.utcnow()
    await db.execute(
        delete(IntradayPriceHistory).where(
            IntradayPriceHistory.interval == "1m",
            IntradayPriceHistory.ts < now - timedelta(days=7),
        )
    )
    if include_history:
        # 90 days is a 12x margin over the longest hourly chart range (7 days);
        # anything older is only ever charted from daily closes.
        await db.execute(
            delete(IntradayPriceHistory).where(
                IntradayPriceHistory.interval == "1h",
                IntradayPriceHistory.ts < now - timedelta(days=90),
            )
        )
        await db.execute(
            delete(IntradayPriceHistory).where(IntradayPriceHistory.interval == "5m")
        )

    await db.commit()
    return len(results)


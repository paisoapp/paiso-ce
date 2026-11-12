"""Yahoo Finance market data with in-process cache (15-min TTL)."""
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from typing import Optional

log = logging.getLogger(__name__)

# Quote caches live in the in-process cache (app/core/cache.py). "last-good"
# values have no TTL: they are the stale fallback when Yahoo errors.
from app.core.cache import cache_delete, cache_get, cache_set

CACHE_TTL = 900  # 15 minutes


def _quote_key(symbol: str) -> str:
    return f"paiso:quote:{symbol}"


def _last_good_key(symbol: str) -> str:
    return f"paiso:quote:lastgood:{symbol}"


def _cached(symbol: str) -> Optional[dict]:
    return cache_get(_quote_key(symbol))


def _store(symbol: str, data: dict, ttl: int = CACHE_TTL) -> None:
    cache_set(_quote_key(symbol), data, ttl)


# ── Backoff for symbols no quote source knows ────────────────────────────────
# A plan fund reported under a made-up ticker (``PLAN.TARGET.2050.FUND``) never
# prices, and a failed lookup costs three Yahoo round trips. Retrying it every
# 60 s — from page loads and from the per-minute refresh alike — is what made
# the Portfolio page slow. A symbol that has *never* priced is retried on a
# doubling delay instead, so a typo or a brand-new listing still recovers
# quickly while a symbol that does not exist settles at a few tries a day.
#
# Kept under its own key because refresh_symbols deletes the quote key to force
# a fetch; the backoff has to survive that.
MISS_BASE_SECONDS = 60
MISS_MAX_SECONDS = 6 * 3600
_MISS_KEY_TTL = 7 * 86400


def _miss_key(symbol: str) -> str:
    return f"paiso:quote:miss:{symbol}"


def _miss_delay(failures: int) -> int:
    """Seconds to wait after the Nth consecutive failure (1-based)."""
    return min(MISS_BASE_SECONDS * 2 ** max(failures - 1, 0), MISS_MAX_SECONDS)


def _in_backoff(symbol: str) -> bool:
    miss = cache_get(_miss_key(symbol))
    return bool(miss) and time.time() < float(miss.get("until") or 0)


def _record_miss(symbol: str) -> int:
    """Count one more failure; returns how long the zero quote may be cached."""
    failures = int((cache_get(_miss_key(symbol)) or {}).get("failures") or 0) + 1
    delay = _miss_delay(failures)
    cache_set(
        _miss_key(symbol),
        {"failures": failures, "until": time.time() + delay},
        _MISS_KEY_TTL,
    )
    return delay


def _et_date(epoch) -> str | None:
    """A Unix timestamp as its America/New_York calendar date (ISO)."""
    import zoneinfo

    try:
        ts = datetime.fromtimestamp(float(epoch), tz=timezone.utc)
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return ts.astimezone(zoneinfo.ZoneInfo("America/New_York")).date().isoformat()


def get_quote(symbol: str) -> dict:
    """Return latest price data for a ticker symbol.

    Three-stage fallback so transient Yahoo Finance errors don't produce zeros:
      1. fast_info  — lightweight endpoint, fastest, most reliable for price
      2. info       — full metadata dict; slower but has name/currency fields
      3. history    — last-resort: grab the most recent daily close

    Successful quotes are cached for CACHE_TTL (15 min).
    A failed quote for a symbol that has priced before is cached for only 60 s
    so it retries promptly; one that has never priced backs off (see
    ``_record_miss``).
    """
    hit = _cached(symbol)
    if hit:
        return hit
    if _in_backoff(symbol):
        return _stale_quote(symbol)

    price = 0.0
    prev_close = 0.0   # stays 0 until a stage fills it; final fallback → price
    regular_price = 0.0   # regular-session close (stable after hours)
    regular_day_change: float | None = None    # from regularMarketChange
    regular_day_change_pct: float | None = None
    day_high: float | None = None
    day_low: float | None = None
    # ET trading date of the regular-session price, so a close is persisted
    # under its own session rather than the server's clock.
    market_date: str | None = None
    name = symbol
    currency = "USD"

    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)

        # ── Stage 1: fast_info — lightweight, most reliable for price ─────────
        try:
            fi = ticker.fast_info
            p = float(fi.last_price or 0)
            if p > 0:
                price = p
                currency = str(getattr(fi, "currency", "USD") or "USD")
                # Only accept prev_close if it's a real non-zero value
                pc = getattr(fi, "previous_close", None)
                if pc:
                    prev_close = float(pc)
            dh = getattr(fi, "day_high", None)
            if dh:
                day_high = float(dh)
            dl = getattr(fi, "day_low", None)
            if dl:
                day_low = float(dl)
        except Exception:
            pass

        # ── Stage 2: info dict — authoritative day_change + name/currency ─────
        try:
            info = ticker.info or {}

            # Price fallback (if fast_info missed)
            if price == 0.0:
                p = (
                    info.get("currentPrice")
                    or info.get("regularMarketPrice")
                    or info.get("navPrice")
                    or info.get("ask")
                    or info.get("bid")
                    or 0.0
                )
                if p:
                    price = float(p)

            # Regular-session price and change — the authoritative values for
            # day change display. After market close, fast_info.previous_close
            # returns today's regular close (not yesterday's), making
            # price - prev_close ≈ 0. regularMarketChange always reflects the
            # official session change vs. the prior day's close.
            rp = info.get("regularMarketPrice")
            if rp:
                regular_price = float(rp)
            rmc = info.get("regularMarketChange")
            if rmc is not None:
                regular_day_change = float(rmc)
            rmcp = info.get("regularMarketChangePercent")
            if rmcp is not None:
                regular_day_change_pct = float(rmcp)
            rmt = info.get("regularMarketTime")
            if rmt:
                market_date = _et_date(rmt)

            # Fill prev_close if Stage 1 didn't set it.
            if prev_close == 0.0:
                if regular_day_change is not None and regular_price > 0:
                    prev_close = regular_price - regular_day_change
                else:
                    pc = info.get("previousClose") or info.get("regularMarketPreviousClose")
                    if pc:
                        prev_close = float(pc)

            name = info.get("shortName") or info.get("longName") or name
            currency = info.get("currency") or currency
        except Exception:
            pass

        # ── Stage 3: history — last resort ───────────────────────────────────
        # Runs when price/prev_close are missing OR when regularMarketChange
        # was not returned by Stage 2 (common after hours for some tickers).
        # Daily history gives the last two official closes, which is all we
        # need to compute the correct session change without ambiguity.
        if price == 0.0 or prev_close == 0.0 or regular_day_change is None:
            try:
                hist = ticker.history(period="5d", interval="1d")
                if not hist.empty:
                    closes = hist["Close"].dropna()
                    if len(closes) >= 1:
                        hist_today = float(closes.iloc[-1])
                        if market_date is None:
                            market_date = closes.index[-1].date().isoformat()
                        if price == 0.0:
                            price = hist_today
                        if not regular_price:
                            regular_price = hist_today
                    if len(closes) >= 2:
                        hist_prev = float(closes.iloc[-2])
                        if prev_close == 0.0:
                            prev_close = hist_prev
                        if regular_day_change is None:
                            # Use history closes — unambiguous regardless of
                            # whether we're in regular or extended hours.
                            _rc = (regular_price or price) - hist_prev
                            regular_day_change = _rc
                            regular_day_change_pct = (_rc / hist_prev * 100) if hist_prev else 0.0
            except Exception:
                pass

    except Exception:
        pass

    # Final fallback: if we never got prev_close, treat it as equal to price
    # (day_change = 0) rather than dividing by zero
    if prev_close == 0.0:
        prev_close = price

    # Prefer the authoritative regular-session change from yfinance (stays
    # correct after hours). Fall back to price - prev_close only when the
    # info dict didn't provide it (e.g. Stage 3 history fallback).
    if regular_day_change is not None:
        day_change = regular_day_change
        if regular_day_change_pct is not None:
            day_change_pct = regular_day_change_pct
        else:
            _base = regular_price - regular_day_change  # = yesterday's close
            day_change_pct = (day_change / _base * 100) if _base > 0 else 0.0
    else:
        day_change = price - prev_close
        day_change_pct = (day_change / prev_close * 100) if prev_close else 0.0

    data = {
        "symbol": symbol,
        "price": price,
        "prev_close": prev_close,
        "regular_price": regular_price or price,
        "day_change": day_change,
        "day_change_pct": day_change_pct,
        "day_high": day_high,
        "day_low": day_low,
        "name": name,
        "currency": currency,
        "market_date": market_date,
        "is_stale": False,
    }

    if price > 0:
        # Successful fetch — update last-good cache and use full TTL
        cache_set(_last_good_key(symbol), dict(data))
        cache_delete(_miss_key(symbol))
        _store(symbol, data)
    else:
        # Failed fetch — return last-good values instead of zeros
        last_good = cache_get(_last_good_key(symbol))
        if last_good:
            stale = dict(last_good)
            stale["is_stale"] = True
            _store(symbol, stale, ttl=60)  # retry soon
            return stale
        # Never priced: cache the zeros, for longer each time it fails again.
        _store(symbol, data, ttl=_record_miss(symbol))

    return data


def get_history(symbol: str, range_key: str = "90d") -> list[dict]:
    """Return OHLCV history. range_key: 90d | ytd | 12m | prior_year."""
    period_map = {
        "90d": ("3mo", None, None),
        "ytd": ("ytd", None, None),
        "12m": ("1y", None, None),
        "prior_year": (None, f"{date.today().year - 1}-01-01", f"{date.today().year - 1}-12-31"),
    }
    period, start, end = period_map.get(range_key, ("3mo", None, None))

    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        if period:
            hist = ticker.history(period=period)
        else:
            hist = ticker.history(start=start, end=end)

        return [
            {
                "date": str(idx.date()),
                "close": float(row["Close"]),
                "volume": int(row.get("Volume", 0)),
            }
            for idx, row in hist.iterrows()
        ]
    except Exception:
        return []


_SEARCH_CACHE_TTL = 300  # 5 minutes — short-lived since it's typeahead, not a quote


def get_symbol_search(query: str, limit: int = 8) -> list[dict]:
    """Ticker/company-name typeahead — lets the user find a symbol without
    already knowing it. Backed by Yahoo's search endpoint (yf.Search), which
    matches on name as well as ticker, so "apple" surfaces AAPL. Results are
    ranked by Yahoo's relevance score and include the exchange/long name so
    similarly-named companies (e.g. Apple Inc. vs Apple Hospitality REIT) can
    be told apart before picking one.
    """
    q = query.strip()
    if not q:
        return []

    cache_key = f"paiso:search:{q.lower()}:{limit}"
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    results: list[dict] = []
    try:
        import yfinance as yf
        search = yf.Search(q, max_results=limit)
        for quote in search.quotes:
            symbol = quote.get("symbol")
            if not symbol or quote.get("quoteType") not in (None, "EQUITY", "ETF", "MUTUALFUND", "INDEX"):
                continue
            results.append({
                "symbol": symbol,
                "name": quote.get("longname") or quote.get("shortname") or symbol,
                "exchange": quote.get("exchDisp") or quote.get("exchange"),
                "type": quote.get("typeDisp") or quote.get("quoteType"),
            })
    except Exception:
        log.warning("get_symbol_search(%s) failed", q, exc_info=True)
        results = []

    cache_set(cache_key, results, _SEARCH_CACHE_TTL)
    return results


def get_daily_single(symbol: str, *, start: date | None = None,
                     end: date | None = None, period: str | None = None) -> list[dict]:
    """Daily closes for one symbol over an explicit window.

    `end` follows yfinance semantics: exclusive.
    """
    try:
        import yfinance as yf
        ticker = yf.Ticker(symbol)
        if period:
            hist = ticker.history(period=period)
        else:
            hist = ticker.history(start=str(start), end=str(end) if end else None)
        if hist is None or hist.empty:
            return []
        return [
            {"date": str(idx.date()), "close": float(val), "volume": 0}
            for idx, val in hist["Close"].items()
            if val == val  # NaN != NaN
        ]
    except Exception as exc:
        log.warning("get_daily_single(%s) failed: %s", symbol, exc)
        return []


def get_dividend_history(symbol: str) -> list[tuple[date, float, float | None]]:
    """Per-share dividend payments (ex-date, amount, close-on-ex-date) from yfinance.

    Uses a single combined history+actions call (auto_adjust=False) so the
    close price lines up with the actual unadjusted price traded that day —
    the DRIP price hint needs the real historical price, not a split/dividend
    back-adjusted one. Slow endpoint — callers should throttle (scheduled
    task) and never block a request path on it. Returns [] on any failure.
    """
    try:
        import yfinance as yf
        hist = yf.Ticker(symbol).history(period="max", auto_adjust=False, actions=True)
        if hist is None or hist.empty or "Dividends" not in hist.columns:
            return []
        out: list[tuple[date, float, float | None]] = []
        for idx, row in hist[hist["Dividends"] > 0].iterrows():
            amount = float(row["Dividends"])
            if amount != amount or amount <= 0:  # NaN != NaN
                continue
            close = row.get("Close")
            price = float(close) if close == close else None  # NaN != NaN
            out.append((idx.date(), amount, price))
        return out
    except Exception as exc:
        log.warning("get_dividend_history(%s) failed: %s", symbol, exc)
        return []


def get_ticker_info(symbol: str) -> dict:
    """Full yfinance .info metadata dict (sector, market cap, PE, ...).

    Slow endpoint — callers should throttle (daily task) and never block a
    request path on it. Returns {} on any failure.
    """
    try:
        import yfinance as yf
        return dict(yf.Ticker(symbol).info or {})
    except Exception as exc:
        log.warning("get_ticker_info(%s) failed: %s", symbol, exc)
        return {}


def expense_ratio_pct_from_info(info: dict) -> float | None:
    """A fund's expense ratio as a **percent** (0.03 = 0.03%) from a yfinance
    .info dict, or None when it reports none (stocks, most non-funds).

    The two fields use different units — checked against live data:
    ``netExpenseRatio`` is a percent (VOO → 0.03, FXAIX → 0.015) while
    ``annualReportExpenseRatio`` is a fraction (FXAIX → 0.00015). The result
    matches ``Security.expense_ratio``, which is stored as a percent.
    """
    pct = info.get("netExpenseRatio")
    if pct is None and info.get("annualReportExpenseRatio") is not None:
        pct = float(info["annualReportExpenseRatio"]) * 100
    if pct is None:
        return None
    pct = float(pct)
    # Anything outside this range is a unit mix-up upstream, not a real fund.
    if not 0 <= pct < 10:
        return None
    return round(pct, 4)


DETAIL_CACHE_TTL = 1800  # 30 minutes — analyst/news data changes slowly


def get_day_and_year_range(symbol: str) -> dict:
    """Day high/low and 52-week high/low via fast_info (lightweight endpoint)."""
    try:
        import yfinance as yf
        fi = yf.Ticker(symbol).fast_info
        return {
            "day_high": float(fi.day_high) if fi.day_high else None,
            "day_low": float(fi.day_low) if fi.day_low else None,
            "week52_high": float(fi.year_high) if fi.year_high else None,
            "week52_low": float(fi.year_low) if fi.year_low else None,
        }
    except Exception as exc:
        log.warning("get_day_and_year_range(%s) failed: %s", symbol, exc)
        return {"day_high": None, "day_low": None, "week52_high": None, "week52_low": None}


def _fetch_info(symbol: str) -> dict:
    """Single .info fetch backing name/analyst/fundamentals — this is yfinance's
    slow endpoint, so callers should share one call rather than each fetching."""
    try:
        import yfinance as yf
        return dict(yf.Ticker(symbol).info or {})
    except Exception as exc:
        log.warning("_fetch_info(%s) failed: %s", symbol, exc)
        return {}


def _analyst_from_info(info: dict) -> dict:
    """Wall-Street analyst rating/consensus fields from a yfinance .info dict."""
    return {
        "rating": info.get("recommendationKey"),
        "score": info.get("recommendationMean"),
        "analyst_count": info.get("numberOfAnalystOpinions"),
        "target_mean": info.get("targetMeanPrice"),
        "target_high": info.get("targetHighPrice"),
        "target_low": info.get("targetLowPrice"),
    }


def _fundamentals_from_info(info: dict) -> dict:
    """Company fundamentals fields from a yfinance .info dict."""
    return {
        "market_cap": info.get("marketCap"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
        "dividend_yield": info.get("dividendYield"),
        "eps_ttm": info.get("trailingEps"),
        "forward_pe": info.get("forwardPE"),
        "price_to_book": info.get("priceToBook"),
        "debt_to_equity": info.get("debtToEquity"),
        "return_on_equity": info.get("returnOnEquity"),
        "revenue": info.get("totalRevenue"),
        "gross_profit": info.get("grossProfits"),
        "free_cash_flow": info.get("freeCashflow"),
        "beta": info.get("beta"),
        "avg_volume": info.get("averageVolume"),
        "short_ratio": info.get("shortRatio"),
    }


def _news_from_search(symbol: str, count: int) -> list[dict]:
    """Headlines from Yahoo's search endpoint, in the drawer's shape."""
    import yfinance as yf
    found = yf.Search(symbol, max_results=1, news_count=count).news or []
    out = []
    for item in found[:count]:
        published = item.get("providerPublishTime")
        out.append({
            "title": item.get("title"),
            "publisher": item.get("publisher"),
            "published_at": (
                datetime.fromtimestamp(published, tz=timezone.utc).isoformat()
                if isinstance(published, (int, float)) else None
            ),
            "url": item.get("link"),
        })
    return out


def _news_from_ticker(symbol: str, count: int) -> list[dict]:
    """Headlines from the ticker's own news stream."""
    import yfinance as yf
    out = []
    for item in (yf.Ticker(symbol).news or [])[:count]:
        content = item.get("content", {}) or {}
        out.append({
            "title": content.get("title"),
            "publisher": (content.get("provider") or {}).get("displayName"),
            "published_at": content.get("pubDate"),
            "url": (content.get("canonicalUrl") or {}).get("url"),
        })
    return out


def get_news(symbol: str, count: int = 5) -> list[dict]:
    """Most recent news headlines for a ticker.

    Search first: Yahoo retired the endpoint behind ``Ticker.news`` (it answers
    404, which yfinance reports as an empty list, so the drawer said "No recent
    news" for every ticker). The ticker stream stays as the second source in
    case search is the one that goes next.
    """
    for source in (_news_from_search, _news_from_ticker):
        try:
            news = source(symbol, count)
        except Exception as exc:
            log.warning("get_news(%s) via %s failed: %s", symbol, source.__name__, exc)
            continue
        if news:
            return news
    log.info("get_news(%s): no headlines from either source", symbol)
    return []


def get_ticker_detail(symbol: str) -> dict:
    """Combined deep-dive payload for the ticker-detail drawer view: name,
    current price, today's/52-week range, fundamentals, analyst consensus,
    and recent news.

    Backs a slow-ish handful of yfinance calls (fast_info + info + news), so
    results are cached for DETAIL_CACHE_TTL — cheap enough for repeated opens
    of the same ticker's drawer without hammering Yahoo Finance.
    """
    cached = cache_get(f"paiso:detail:{symbol}")
    if cached is not None:
        return cached

    quote = get_quote(symbol)
    range_info = get_day_and_year_range(symbol)
    info = _fetch_info(symbol)
    payload = {
        "symbol": symbol,
        "name": info.get("longName") or info.get("shortName"),
        "price": quote.get("price"),
        "day_change": quote.get("day_change"),
        "day_change_pct": quote.get("day_change_pct"),
        **range_info,
        "fundamentals": _fundamentals_from_info(info),
        "analyst": _analyst_from_info(info),
        "news": get_news(symbol, 5),
    }
    cache_set(f"paiso:detail:{symbol}", payload, DETAIL_CACHE_TTL)
    return payload


def _stale_quote(symbol: str) -> dict:
    """A zero-valued, stale placeholder quote for a symbol with no cached data."""
    return {
        "symbol": symbol,
        "price": 0.0,
        "prev_close": 0.0,
        "regular_price": 0.0,
        "day_change": 0.0,
        "day_change_pct": 0.0,
        "day_high": None,
        "day_low": None,
        "name": symbol,
        "currency": "USD",
        "is_stale": True,
    }


def get_quotes_cached(symbols: list[str]) -> dict[str, dict]:
    """Non-blocking quote read used on hot request paths (e.g. the dashboard).

    Returns, per symbol, the best data already in memory WITHOUT ever hitting the
    network: a live cache hit, else the last-good value (marked stale), else a
    zero placeholder marked stale. Callers can fall back to a persisted close for
    stale symbols and schedule a background ``refresh_symbols`` to warm the cache.
    """
    out: dict[str, dict] = {}
    for s in symbols:
        hit = _cached(s)
        if hit:
            out[s] = hit
            continue
        last_good = cache_get(_last_good_key(s))
        if last_good:
            stale = dict(last_good)
            stale["is_stale"] = True
            out[s] = stale
        else:
            out[s] = _stale_quote(s)
    return out


def refresh_symbols(symbols: list[str]) -> dict[str, dict]:
    """Parallel bulk quote refresh — one thread per ticker, up to 8 concurrent."""
    cache_delete(*[_quote_key(s) for s in symbols])
    if not symbols:
        return {}
    workers = min(len(symbols), 8)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(get_quote, s): s for s in symbols}
        return {futures[f]: f.result() for f in as_completed(futures)}


def _to_utc_naive(ts) -> datetime:
    """Convert a pandas Timestamp (tz-aware) to a naive UTC datetime."""
    try:
        return ts.astimezone(timezone.utc).replace(tzinfo=None)
    except Exception:
        return ts.to_pydatetime().replace(tzinfo=None)


def get_intraday(symbol: str, interval: str = "1m") -> list[dict]:
    """Fetch intraday bars for a single symbol."""
    period = "5d" if interval == "1h" else "2d"
    try:
        import yfinance as yf
        hist = yf.Ticker(symbol).history(period=period, interval=interval)
        if hist is None or hist.empty:
            return []
        return [
            {"ts": _to_utc_naive(idx).isoformat(), "close": float(row["Close"])}
            for idx, row in hist.iterrows()
            if row["Close"] == row["Close"]  # skip NaN
        ]
    except Exception as exc:
        log.warning("get_intraday(%s, %s) failed: %s", symbol, interval, exc)
        return []


def get_intraday_bulk(symbols: list[str], interval: str = "1m") -> dict[str, list[dict]]:
    """Fetch intraday OHLCV bars for all symbols in one yf.download() call.

    interval: "1m" (last 7 days max) | "1h" (last 730 days max)
    Timestamps are converted to naive UTC datetimes and returned as ISO strings.

    yfinance intraday period limits:
      - "1m"  → max 7 days   (we fetch "2d" — today + yesterday)
      - "5m"  → max 60 days
      - "1h"  → max 730 days (we fetch "5d")

    Retries the bulk download once on failure, then falls back to parallel
    per-symbol fetches so a transient error never silently drops all intraday data.
    """
    if not symbols:
        return {}

    period = "5d" if interval == "1h" else "2d"

    def _parse_df(df) -> dict[str, list[dict]]:
        result: dict[str, list[dict]] = {}
        if len(symbols) == 1:
            sym = symbols[0]
            close_col = df.get("Close", df)
            result[sym] = [
                {"ts": _to_utc_naive(idx).isoformat(), "close": float(val)}
                for idx, val in close_col.items()
                if val == val
            ]
        else:
            for sym in symbols:
                try:
                    series = df["Close"][sym]
                    result[sym] = [
                        {"ts": _to_utc_naive(idx).isoformat(), "close": float(val)}
                        for idx, val in series.items()
                        if val == val
                    ]
                except (KeyError, TypeError):
                    result[sym] = []
        return result

    import yfinance as yf
    kwargs: dict = dict(progress=False, auto_adjust=True, threads=True, multi_level_index=True, timeout=10)
    tickers_str = " ".join(symbols)

    last_exc: Exception | None = None
    for attempt in range(2):
        try:
            df = yf.download(tickers_str, period=period, interval=interval, **kwargs)
            if df is None or df.empty:
                raise ValueError("empty intraday result")
            return _parse_df(df)
        except Exception as exc:
            last_exc = exc
            log.warning(
                "get_intraday_bulk attempt %d/%d failed for interval=%s (%d symbols): %s",
                attempt + 1, 2, interval, len(symbols), exc,
            )

    log.warning(
        "get_intraday_bulk bulk download failed after 2 attempts (interval=%s); "
        "falling back to per-symbol fetches. Last error: %s",
        interval, last_exc,
    )
    workers = min(len(symbols), 8)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(get_intraday, s, interval): s for s in symbols}
        return {futures[f]: f.result() for f in as_completed(futures)}


def get_daily_bulk(symbols: list[str], *, start: date | None = None,
                   end: date | None = None, period: str | None = None) -> dict[str, list[dict]]:
    """
    Batch-download daily closes for all symbols in one yf.download() call over
    an explicit window (start/end, end exclusive per yfinance) or a period.
    yfinance runs per-ticker requests in parallel internally (threads=True).
    Falls back to parallel individual fetches if the batch call fails.
    """
    if not symbols:
        return {}

    try:
        import yfinance as yf

        tickers_str = " ".join(symbols)
        kwargs: dict = dict(progress=False, auto_adjust=True, threads=True, multi_level_index=True, timeout=10)
        df = yf.download(tickers_str, period=period, **kwargs) if period else \
             yf.download(tickers_str, start=str(start), end=str(end) if end else None, **kwargs)

        if df is None or df.empty:
            raise ValueError("empty download result")

        result: dict[str, list[dict]] = {}

        if len(symbols) == 1:
            sym = symbols[0]
            close_col = df.get("Close", df)
            result[sym] = [
                {"date": str(idx.date()), "close": float(val), "volume": 0}
                for idx, val in close_col.items()
                if val == val  # NaN != NaN, so this skips NaNs
            ]
        else:
            # MultiIndex columns: ("Close", "AAPL"), ("Close", "TSLA"), ...
            for sym in symbols:
                try:
                    series = df["Close"][sym]
                    result[sym] = [
                        {"date": str(idx.date()), "close": float(val), "volume": 0}
                        for idx, val in series.items()
                        if val == val
                    ]
                except (KeyError, TypeError):
                    result[sym] = get_daily_single(sym, start=start, end=end, period=period)

        return result

    except Exception:
        # Fallback: parallel individual fetches
        workers = min(len(symbols), 8)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(get_daily_single, s, start=start, end=end, period=period): s
                for s in symbols
            }
            return {futures[f]: f.result() for f in as_completed(futures)}


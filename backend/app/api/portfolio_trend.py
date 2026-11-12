"""Portfolio historical value trend endpoint — daily and intraday."""
import bisect
from datetime import date, datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.models.user import User
from app.models.holding import Holding
from app.models.security import IntradayPriceHistory, PriceHistory, Security

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])

VALID_INTERVALS = {"1d", "1h", "5m", "1m"}
# Single-session intraday "Today" views (most-recent-session window + RTH scoping).
_SESSION_INTERVALS = ("1m", "5m")


def _latest_at_or_before(sorted_pairs: list[tuple], target) -> Optional[float]:
    """Binary search for the most recent price at or before `target`."""
    keys = [p[0] for p in sorted_pairs]
    idx = bisect.bisect_right(keys, target) - 1
    return sorted_pairs[idx][1] if idx >= 0 else None


@router.get("/trend")
async def portfolio_trend(
    days: int = Query(default=90, ge=1, le=36500),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    account_id: Optional[int] = Query(None),
    # comma-separated; a tab's accounts (Stocks & Funds charts only its own)
    account_ids: Optional[str] = Query(None),
    security_ids: Optional[str] = Query(None),  # comma-separated
    breakdown: bool = Query(False),
    # comma-separated account ids whose own value series to return for
    # overlaying (a plan on the Retirement tab), keyed "acct:<id>" in by_ticker
    overlay_accounts: Optional[str] = Query(None),
    # Sum the accounts' own value series instead of priced holdings alone.
    plans: bool = Query(False),
    interval: str = Query(default="1d"),         # "1d" | "1h" | "5m"
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    if not user_acct_ids:
        return {"series": []}

    if interval not in VALID_INTERVALS:
        interval = "1d"

    cutoff = date.fromisoformat(date_from) if date_from else date.today() - timedelta(days=days)
    end_date = date.fromisoformat(date_to) if date_to else date.today()

    # ── Build holdings filter ─────────────────────────────────────────────────
    # Every chart this serves is on Investments, where "Exclude from net
    # worth" changes nothing: an excluded holding or account still counts
    # toward the tab's value and its line. Net worth is charted elsewhere
    # (reconstruct_net_worth), and leaves them out there.
    holding_filter = [Holding.account_id.in_(user_acct_ids)]
    if account_id is not None:
        if account_id in user_acct_ids:
            holding_filter.append(Holding.account_id == account_id)
        else:
            return {"series": []}
    if isinstance(account_ids, str) and account_ids:
        try:
            scope = {int(a) for a in account_ids.split(",") if a.strip()} & set(user_acct_ids)
        except ValueError:
            scope = set()
        if not scope:
            return {"series": []}
        holding_filter.append(Holding.account_id.in_(scope))

    # Plan tabs (Retirement, Education, Health): the line is each plan's own
    # value over time, summed — a plan with no priced positions (a value the
    # user enters, an institution balance) counts too. Daily only.
    if plans is True:
        return await _plans_trend(
            db, user.id, scope if isinstance(account_ids, str) and account_ids else set(user_acct_ids),
            cutoff, end_date, breakdown, overlay_accounts,
        )

    holdings = await _valued_holdings(db, holding_filter)
    if not holdings:
        return {"series": []}

    parsed_sec_ids: Optional[set[int]] = None
    if security_ids:
        try:
            parsed_sec_ids = {int(s) for s in security_ids.split(",") if s.strip()}
        except ValueError:
            pass

    shares_by_security: dict[int, float] = {}
    for h in holdings:
        if parsed_sec_ids is not None and h.security_id not in parsed_sec_ids:
            continue
        shares_by_security[h.security_id] = (
            shares_by_security.get(h.security_id, 0.0) + float(h.shares or 0)
        )

    if not shares_by_security:
        return {"series": []}

    # ── Route to intraday or daily ────────────────────────────────────────────
    if interval in ("1m", "5m", "1h"):
        return await _intraday_trend(
            db, shares_by_security, cutoff, end_date, interval, breakdown
        )
    else:
        return await _daily_trend(
            db, shares_by_security, cutoff, end_date, breakdown
        )


async def _valued_holdings(db, holding_filter) -> list[Holding]:
    """The holdings that value their account. Exclusion from net worth does
    not matter here."""
    return list((await db.scalars(select(Holding).where(*holding_filter))).all())


async def _plans_trend(db, user_id: int, scope: set[int], cutoff: date, end_date: date,
                       breakdown: bool, overlay_accounts) -> dict:
    from app.modules.portfolio.account_history import account_balance_series

    per_account = await account_balance_series(
        db, user_id, cutoff, end_date, include_excluded=True,
    )
    # Every plan in view is in the line, excluded from net worth or not:
    # exclusion is about net worth only, never about the plan's own
    # performance on Investments.
    totals: dict[str, float] = {}
    for aid in scope:
        for pt in per_account.get(aid, []):
            totals[pt["date"]] = totals.get(pt["date"], 0.0) + pt["balance"]
    out: dict = {"series": [{"date": d, "value": round(v, 2)} for d, v in sorted(totals.items())]}
    if not breakdown:
        return out

    # Plans can be overlaid against each other; the tickers inside them are
    # not offered on these tabs.
    by_ticker: dict = {}
    if isinstance(overlay_accounts, str) and overlay_accounts:
        for raw_id in overlay_accounts.split(","):
            try:
                aid = int(raw_id)
            except ValueError:
                continue
            if aid in scope:
                by_ticker[f"acct:{aid}"] = [
                    {"date": pt["date"], "close": pt["balance"]} for pt in per_account.get(aid, [])
                ]
    out["by_ticker"] = by_ticker
    return out


async def _daily_trend(
    db: AsyncSession,
    shares_by_security: dict[int, float],
    cutoff: date,
    end_date: date,
    breakdown: bool,
) -> dict:
    rows = (await db.execute(
        select(PriceHistory.security_id, PriceHistory.as_of, PriceHistory.close)
        .where(
            and_(
                PriceHistory.security_id.in_(list(shares_by_security.keys())),
                PriceHistory.as_of >= cutoff,
                PriceHistory.as_of <= end_date,
            )
        )
        .order_by(PriceHistory.as_of)
    )).all()

    if not rows:
        return {"series": []}

    # Observations, per security, in date order.
    observed: dict[int, dict[date, float]] = {}
    for security_id, as_of, close in rows:
        if close is None:
            continue
        observed.setdefault(security_id, {})[as_of] = float(close)

    if not observed:
        return {"series": []}

    # Every date any security was priced on. Securities do not share a calendar:
    # yfinance writes weekdays only, while a price from an imported statement
    # lands on whatever day it was observed, weekends included.
    all_dates = sorted({d for prices in observed.values() for d in prices})

    # Carry each security's last known close forward across that calendar.
    #
    # Without this the total was the sum of only the securities that happened to
    # have a row on each date, so a Sunday on which one security had a mark and
    # twenty did not valued the whole portfolio at that one position — the chart
    # collapsed from $5.4M to $18 and back, once a week, for a year.
    #
    # A security with no observation *yet* contributes nothing, which is right:
    # before its first close there is no price to carry.
    per_security: dict[int, dict[date, float]] = {}
    daily_values: dict[date, float] = {}
    priced_count: dict[date, int] = {}
    for security_id, prices in observed.items():
        shares = shares_by_security.get(security_id, 0.0)
        last: float | None = None
        filled: dict[date, float] = {}
        for d in all_dates:
            if d in prices:
                last = prices[d]
            if last is None:
                continue
            filled[d] = last
            daily_values[d] = daily_values.get(d, 0.0) + shares * last
            priced_count[d] = priced_count.get(d, 0) + 1
        if breakdown:
            per_security[security_id] = filled

    # Drop the leading stretch where barely any of the portfolio has a price yet.
    #
    # The window's first date is whatever date *any* security was observed on,
    # and that is often a holiday or weekend carrying a single institution mark
    # while the twenty market-priced securities' history only starts on the next
    # trading day. The chart then opened at one small position, jumped
    # vertically to the full total, and the period change read as a gain of
    # many thousand percent. That is what "This year" showed
    # while "Last 12 months" (starting on an ordinary trading day) looked fine.
    #
    # Shares are today's throughout, so a partly-priced date is never a real
    # portfolio value — only a gap in price history. Coverage never falls once a
    # security's first close is carried forward, so this only ever trims a
    # prefix. The bar is half the securities: a date missing one or two of
    # twenty is still an honest baseline and stays.
    if priced_count:
        min_covered = max(priced_count.values()) / 2
        kept = {d for d, n in priced_count.items() if n >= min_covered}
        daily_values = {d: v for d, v in daily_values.items() if d in kept}
        if breakdown:
            per_security = {
                sec_id: {d: p for d, p in prices.items() if d in kept}
                for sec_id, prices in per_security.items()
            }

    series = [
        {"date": d.isoformat(), "value": round(v, 2)}
        for d, v in sorted(daily_values.items())
    ]

    if not breakdown:
        return {"series": series}

    sec_ids = list(per_security.keys())
    securities = (await db.scalars(select(Security).where(Security.id.in_(sec_ids)))).all()
    ticker_map: dict[int, str] = {s.id: (s.ticker or s.name) for s in securities}

    by_ticker: dict[str, list[dict]] = {}
    for sec_id, date_prices in per_security.items():
        ticker = ticker_map.get(sec_id, str(sec_id))
        by_ticker[ticker] = [
            {"date": d.isoformat(), "close": round(p, 4)}
            for d, p in sorted(date_prices.items())
        ]

    return {"series": series, "by_ticker": by_ticker}


_ET = ZoneInfo("America/New_York")
_RTH_OPEN_MIN = 9 * 60 + 30    # 09:30 ET
_RTH_CLOSE_MIN = 16 * 60       # 16:00 ET


def _to_et(ts_utc_naive: datetime) -> datetime:
    """Interpret a naive-UTC bar timestamp (how they're stored) as aware ET."""
    return ts_utc_naive.replace(tzinfo=timezone.utc).astimezone(_ET)


def _in_regular_hours(ts_utc_naive: datetime) -> bool:
    """True if the bar is inside regular US trading hours (Mon–Fri 09:30–16:00 ET)."""
    et = _to_et(ts_utc_naive)
    if et.weekday() >= 5:
        return False
    mins = et.hour * 60 + et.minute
    return _RTH_OPEN_MIN <= mins <= _RTH_CLOSE_MIN


def _session_window_utc(session_date: date) -> tuple[datetime, datetime]:
    """Naive-UTC [09:30, 16:00] ET bounds for a given ET trading date."""
    open_et = datetime(session_date.year, session_date.month, session_date.day, 9, 30, tzinfo=_ET)
    close_et = datetime(session_date.year, session_date.month, session_date.day, 16, 0, tzinfo=_ET)
    def _naive(d: datetime) -> datetime:
        return d.astimezone(timezone.utc).replace(tzinfo=None)
    return _naive(open_et), _naive(close_et)


def _session_meta(session_date: Optional[date], now_et: datetime) -> dict:
    """Describe the session shown so the UI can label it and flag a closed market."""
    mins = now_et.hour * 60 + now_et.minute
    market_open = now_et.weekday() < 5 and _RTH_OPEN_MIN <= mins < _RTH_CLOSE_MIN
    return {
        "date": session_date.isoformat() if session_date else None,
        "is_current": bool(session_date and session_date == now_et.date()),
        "market_open": market_open,
    }


async def _intraday_trend(
    db: AsyncSession,
    shares_by_security: dict[int, float],
    cutoff: date,
    end_date: date,
    interval: str,
    breakdown: bool,
) -> dict:
    sec_ids = list(shares_by_security.keys())
    now_et = datetime.now(_ET)

    # Query window (naive UTC, matching how bars are stored). For the single-
    # session "Today" view we render the most recent *session*, so we look back a
    # week to find it (covers weekends/holidays); for 1h we honour the date range.
    if interval in _SESSION_INTERVALS:
        lower = datetime.utcnow() - timedelta(days=7)
        upper = datetime.utcnow()
    else:
        lower = datetime(cutoff.year, cutoff.month, cutoff.day, 0, 0, 0)
        upper = datetime(end_date.year, end_date.month, end_date.day, 23, 59, 59)

    rows = (await db.execute(
        select(
            IntradayPriceHistory.security_id,
            IntradayPriceHistory.ts,
            IntradayPriceHistory.close,
        )
        .where(
            and_(
                IntradayPriceHistory.security_id.in_(sec_ids),
                IntradayPriceHistory.interval == interval,
                IntradayPriceHistory.ts >= lower,
                IntradayPriceHistory.ts <= upper,
            )
        )
        .order_by(IntradayPriceHistory.ts)
    )).all()

    # Regular trading hours only — drop pre-market, after-hours, and weekends.
    rows = [r for r in rows if _in_regular_hours(r[1])]
    if not rows:
        return {"series": [], "session": _session_meta(None, now_et)}

    # Session to display = the ET date of the most recent regular-hours bar:
    # today's if the market has traded, else the last session (Fri on a weekend,
    # the prior day before the open, …).
    session_date = max(_to_et(ts).date() for _, ts, _ in rows)

    if interval in _SESSION_INTERVALS:
        open_utc, close_utc = _session_window_utc(session_date)
        rows = [r for r in rows if open_utc <= r[1] <= close_utc]
        anchor_dt: Optional[datetime] = open_utc
        prev_cutoff = session_date
        if not rows:
            return {"series": [], "session": _session_meta(session_date, now_et)}
    else:
        anchor_dt = None
        prev_cutoff = cutoff

    # Group prices by security for carry-forward lookup
    price_series: dict[int, list[tuple[datetime, float]]] = {}
    per_security: dict[int, dict[datetime, float]] = {}
    for security_id, ts, close in rows:
        if close is None:
            continue
        close_f = float(close)
        price_series.setdefault(security_id, []).append((ts, close_f))
        if breakdown:
            per_security.setdefault(security_id, {})[ts] = close_f

    # ── Seed carry-forward with the previous session's official daily close ───
    # Securities with no intraday bars in the window (mutual funds, thinly-traded
    # names, NaN bars) would otherwise contribute $0 and understate the total;
    # seeding each one's prior close at the anchor carries it forward.
    prev_date_subq = (
        select(
            PriceHistory.security_id,
            func.max(PriceHistory.as_of).label("max_date"),
        )
        .where(
            and_(
                PriceHistory.security_id.in_(sec_ids),
                PriceHistory.as_of < prev_cutoff,
            )
        )
        .group_by(PriceHistory.security_id)
        .subquery()
    )
    prev_rows = (await db.execute(
        select(PriceHistory.security_id, PriceHistory.close)
        .join(
            prev_date_subq,
            and_(
                PriceHistory.security_id == prev_date_subq.c.security_id,
                PriceHistory.as_of == prev_date_subq.c.max_date,
            ),
        )
    )).all()
    prev_close_map: dict[int, float] = {
        sec_id: float(close) for sec_id, close in prev_rows if close is not None
    }

    seed_dt = anchor_dt if anchor_dt is not None else rows[0][1]
    for sec_id, prev_close in prev_close_map.items():
        price_series.setdefault(sec_id, []).insert(0, (seed_dt, prev_close))

    all_ts = sorted({ts for _, ts, _ in rows})
    series = []
    for ts in all_ts:
        total = 0.0
        for sec_id, shares in shares_by_security.items():
            price = _latest_at_or_before(price_series.get(sec_id, []), ts)
            if price is not None:
                total += shares * price
        if total > 0:
            # UTC ISO + Z so the frontend Date() parses correctly, then renders
            # the label in the viewer's local timezone.
            series.append({"date": ts.isoformat() + "Z", "value": round(total, 2)})

    # Anchor the single-session "Today" line at the previous session's close,
    # plotted at the open, so gain = lastVal − firstVal == today's change.
    if interval in _SESSION_INTERVALS and series and prev_close_map and anchor_dt is not None:
        baseline = sum(
            shares_by_security.get(sec_id, 0.0) * close
            for sec_id, close in prev_close_map.items()
        )
        if baseline > 0:
            series.insert(0, {"date": anchor_dt.isoformat() + "Z", "value": round(baseline, 2)})

    result: dict = {"series": series, "session": _session_meta(session_date, now_et)}

    if breakdown:
        sec_objs = (await db.scalars(
            select(Security).where(Security.id.in_(list(per_security.keys())))
        )).all()
        ticker_map = {s.id: (s.ticker or s.name) for s in sec_objs}
        result["by_ticker"] = {
            ticker_map.get(sec_id, str(sec_id)): [
                {"date": ts.isoformat() + "Z", "close": round(p, 4)}
                for ts, p in sorted(ts_prices.items())
            ]
            for sec_id, ts_prices in per_security.items()
        }

    return result

import asyncio
import logging
from datetime import datetime, date, timedelta, timezone

log = logging.getLogger(__name__)


#: Extra conditions every market-data pass adds beside "has a ticker".
#:
#: Keyed on the *symbol*, not the security's type: Vanguard reports VMFXX, a
#: quotable fund with a real ticker, as a cash security, so excluding the type
#: would stop pricing it. A currency identifier (``CUR:USD``) is the thing
#: worth excluding, and a hand-added holding can carry anything.
def _quotable_conditions():
    from app.models.security import Security

    return (Security.ticker.notlike("CUR:%"),)


def refresh_all_market_data():
    """Live prices for every held security: quotes + 1-minute bars. Runs every
    60s during market hours.

    This is what keeps the investments/portfolio/dashboard pages instant: the
    API serves prices straight from the DB/cache, and this job (on the
    scheduler's own thread) keeps that store fresh so no user request triggers a blocking Yahoo
    Finance call. It deliberately skips the slow-changing 12-month daily history
    and 1-hour bars — those ride on refresh_market_history so we don't re-download
    a year of data every minute.
    """
    return asyncio.run(_run_market_refresh(include_history=False))


def refresh_market_history():
    """Slow-changing data for every held security: 12-month daily closes + 1-hour
    bars. Runs every ~10 minutes during market hours (these change at most once a
    day / once an hour, so they don't belong on the 60-second live pass)."""
    return asyncio.run(_run_market_refresh(include_history=True))


async def _run_market_refresh(include_history: bool) -> dict:
    from datetime import datetime
    import zoneinfo

    from sqlalchemy import select

    from app.core.database import task_session
    from app.models.holding import Holding
    from app.models.security import Security
    from app.modules.investments.refresh import refresh_and_persist

    # Skip outside the active window (weekdays, ~09:00–18:00 ET) — covering
    # pre-open warm-up, trading hours, and the post-close official close — so we
    # don't hammer the data provider overnight or on weekends.
    et = datetime.now(tz=zoneinfo.ZoneInfo("America/New_York"))
    if et.weekday() >= 5 or not (9 <= et.hour < 18):
        return {"skipped": True, "reason": "outside market refresh window"}

    async with task_session() as db:
        securities = (await db.scalars(
            select(Security)
            .join(Holding, Holding.security_id == Security.id)
            .where(Security.ticker.isnot(None), *_quotable_conditions())
            .distinct()
        )).all()
        refreshed = await refresh_and_persist(db, securities, include_history=include_history)

    return {"refreshed": refreshed, "securities": len(securities), "history": include_history}


def refresh_market_history_full():
    """Weekly (Saturday) full re-download of the daily-close lookback for every
    held security. Safety net for the incremental history pass: yfinance
    back-adjusts all past closes after splits/dividends, and while the
    incremental pass detects that via a 5-day overlap check, this weekly pass
    guarantees the stored series converges to the adjusted basis regardless.
    Deliberately NOT gated on the market-hours window — it runs on weekends."""
    return asyncio.run(_run_full_history_refresh())


async def _run_full_history_refresh() -> dict:
    from sqlalchemy import select

    from app.core.database import task_session
    from app.models.holding import Holding
    from app.models.security import Security
    from app.modules.investments.backfill import ensure_daily_coverage
    from app.modules.investments.refresh import prune_stray_closes

    async with task_session() as db:
        securities = (await db.scalars(
            select(Security)
            .join(Holding, Holding.security_id == Security.id)
            .where(Security.ticker.isnot(None), *_quotable_conditions())
            .distinct()
        )).all()
        rows = await ensure_daily_coverage(db, list(securities), force_full=True)
        pruned = await prune_stray_closes(db, list(securities))
        await db.commit()

    return {"securities": len(securities), "rows_written": rows, "rows_pruned": pruned}


def refresh_security_info():
    """Daily (post-close) refresh of per-ticker metadata (sector, market cap,
    PE, dividend yield, 52-week range, ...) into security_info. Feeds current
    and future ticker-detail UI without touching the request path."""
    return asyncio.run(_refresh_security_info_async())


async def _refresh_security_info_async() -> dict:
    import json
    from concurrent.futures import ThreadPoolExecutor

    from sqlalchemy import select
    from app.core.upsert import dialect_insert

    from app.core.database import task_session
    from app.models.holding import Holding
    from app.models.security import Security, SecurityInfo
    from app.modules.investments.market_data import expense_ratio_pct_from_info, get_ticker_info

    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC, like other timestamps
    fresh_cutoff = now - timedelta(hours=20)

    async with task_session() as db:
        securities = (await db.scalars(
            select(Security)
            .join(Holding, Holding.security_id == Security.id)
            .where(Security.ticker.isnot(None), *_quotable_conditions())
            .distinct()
        )).all()

        # Skip anything refreshed in the last ~20h so manual triggers are cheap.
        fresh_ids = set((await db.scalars(
            select(SecurityInfo.security_id).where(SecurityInfo.updated_at > fresh_cutoff)
        )).all())
        todo = [s for s in securities if s.id not in fresh_ids]

        # Fill missing expense ratios. The Add Holding form only asks when a security is first created, so without
        # this most funds read as "fee unknown" on the Portfolio page. Never
        # overwrites a value that is already there (a user's own entry wins).
        # Fresh rows are served from the stored payload — no network.
        backfilled = 0
        missing_er_fresh = [s for s in securities if s.id in fresh_ids and s.expense_ratio is None]
        if missing_er_fresh:
            stored = dict((await db.execute(
                select(SecurityInfo.security_id, SecurityInfo.info_json)
                .where(SecurityInfo.security_id.in_([s.id for s in missing_er_fresh]))
            )).all())
            for sec in missing_er_fresh:
                try:
                    er = expense_ratio_pct_from_info(json.loads(stored.get(sec.id) or "{}"))
                except (TypeError, ValueError):
                    er = None
                if er is not None:
                    sec.expense_ratio = er
                    backfilled += 1

        if not todo:
            await db.commit()
            return {"refreshed": 0, "skipped_fresh": len(securities), "expense_ratios_filled": backfilled}

        # .info is yfinance's slow endpoint — modest parallelism is plenty.
        loop = asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=4) as pool:
            infos = await asyncio.gather(*[
                loop.run_in_executor(pool, get_ticker_info, s.ticker) for s in todo
            ])

        refreshed = 0
        for sec, info in zip(todo, infos):
            if not info:
                continue
            values = {
                "security_id": sec.id,
                "updated_at": now,
                "sector": info.get("sector"),
                "industry": info.get("industry"),
                "market_cap": info.get("marketCap"),
                "pe_ratio": info.get("trailingPE"),
                "dividend_yield": info.get("dividendYield"),
                "week52_high": info.get("fiftyTwoWeekHigh"),
                "week52_low": info.get("fiftyTwoWeekLow"),
                "info_json": json.dumps(info, default=str),
            }
            stmt = dialect_insert(SecurityInfo).values(**values)
            stmt = stmt.on_conflict_do_update(
                index_elements=["security_id"],
                set_={k: v for k, v in values.items() if k != "security_id"},
            )
            await db.execute(stmt)
            refreshed += 1

            if sec.expense_ratio is None:
                er = expense_ratio_pct_from_info(info)
                if er is not None:
                    sec.expense_ratio = er
                    backfilled += 1

        await db.commit()

    return {"refreshed": refreshed, "skipped_fresh": len(fresh_ids), "expense_ratios_filled": backfilled}


def refresh_dividend_history():
    """Weekly sync of a security's full dividend-payment history (as far back as
    yfinance has it — often since inception) for every held security into
    security_dividend. Feeds the dividend-suggestions endpoint — nothing is
    auto-recorded; users confirm suggestions into Trade rows. Upsert-keyed on
    (security_id, ex_date), so re-fetching full history each run is cheap and
    matches the weekly full-refresh pattern used for price history."""
    return asyncio.run(_refresh_dividend_history_async())


async def _refresh_dividend_history_async() -> dict:
    from concurrent.futures import ThreadPoolExecutor

    from sqlalchemy import select

    from app.core.database import task_session
    from app.models.holding import Holding
    from app.models.security import Security
    from app.modules.investments.dividends import upsert_dividends
    from app.modules.investments.market_data import get_dividend_history

    async with task_session() as db:
        securities = (await db.scalars(
            select(Security)
            .join(Holding, Holding.security_id == Security.id)
            .where(Security.ticker.isnot(None), *_quotable_conditions())
            .distinct()
        )).all()
        if not securities:
            return {"securities": 0, "rows_written": 0}

        loop = asyncio.get_running_loop()
        with ThreadPoolExecutor(max_workers=4) as pool:
            histories = await asyncio.gather(*[
                loop.run_in_executor(pool, get_dividend_history, s.ticker)
                for s in securities
            ])

        rows_written = 0
        for sec, divs in zip(securities, histories):
            rows_written += await upsert_dividends(db, sec, divs)

        await db.commit()

    return {"securities": len(securities), "rows_written": rows_written}


def rematch_transfers():
    """Nightly pass to pair transfer legs that arrived separately.

    The two sides of one movement often come from different institutions,
    whose syncs run at different times, so a pair that was invisible during
    one import becomes obvious later.
    """
    return asyncio.run(_rematch_transfers_async())


async def _rematch_transfers_async() -> dict:
    from datetime import timedelta

    from sqlalchemy import select

    from app.core.database import task_session
    from app.models.account import Account
    from app.models.transaction import Transaction
    from app.modules.budgeting.transfer_matcher import match_transfers

    cutoff = date.today() - timedelta(days=30)
    # Reported separately. An operator running this by hand is usually asking
    # "did the backlog clear?", and rolling promotions and discards into a
    # single "linked" count answered a different question — the previous
    # return said `linked: 0` on a run that had just confirmed a hundred
    # existing suggestions, because neither pass was counted.
    totals = {"confirmed": 0, "suggested": 0, "promoted": 0, "discarded": 0}
    async with task_session() as db:
        user_ids = list((await db.scalars(select(Account.user_id).distinct())).all())

    for user_id in user_ids:
        try:
            async with task_session() as db:
                recent = list((await db.scalars(
                    select(Transaction.id)
                    .join(Account, Account.id == Transaction.account_id)
                    .where(
                        Account.user_id == user_id,
                        Transaction.date_posted >= cutoff,
                    )
                )).all())
                if not recent:
                    continue
                out = await match_transfers(db, user_id, transaction_ids=recent)
                for key in totals:
                    totals[key] += out.get(key, 0)
        except Exception:
            log.warning("rematch_transfers failed for user %s", user_id, exc_info=True)
    return {"users": len(user_ids), **totals}


def sweep_orphaned_files():
    """Remove stored files no row owns: abandoned CSV uploads and receipts of
    deleted transactions. See ``modules/maintenance/files.py``."""
    return asyncio.run(_sweep_orphaned_files_async())


async def _sweep_orphaned_files_async() -> dict:
    from app.core.database import task_session
    from app.modules.maintenance.files import sweep_orphaned_files as sweep

    async with task_session() as db:
        return await sweep(db)

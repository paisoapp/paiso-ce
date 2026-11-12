"""The scheduled jobs, run inside the API process.

APScheduler's background scheduler calls the job functions in
``app.workers.tasks`` on its own thread pool. Each job opens its own event loop
(``asyncio.run``) and its own database engine (``task_session``), so a slow
market-data call never holds up a request. Cron times are US Eastern, which is
what the market-hours windows inside the jobs assume.

One process runs the app, so one scheduler runs each job once.
"""
import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.workers import tasks

log = logging.getLogger(__name__)

_TZ = "America/New_York"

#: (job id, function, trigger)
JOBS = [
    # Live prices (quotes + 1-minute bars) every minute. A no-op outside the
    # 09:00 to 18:00 ET window.
    ("refresh-market-data", tasks.refresh_all_market_data, IntervalTrigger(seconds=60)),
    # Daily closes and 1-hour bars every 10 minutes: they change at most once
    # a day or once an hour. Also a no-op outside market hours.
    ("refresh-market-history", tasks.refresh_market_history, IntervalTrigger(seconds=600)),
    # Weekly full re-download of the daily-close lookback, a safety net against
    # split and dividend back-adjustments. Saturday morning.
    ("refresh-market-history-full", tasks.refresh_market_history_full,
     CronTrigger(day_of_week="sat", hour=10, minute=0, timezone=_TZ)),
    # Per-ticker metadata (sector, market cap, PE) once a day after the close.
    ("refresh-security-info", tasks.refresh_security_info,
     CronTrigger(day_of_week="mon-fri", hour=17, minute=30, timezone=_TZ)),
    # Per-share dividend history, weekly beside the full-history pass.
    ("refresh-dividend-history", tasks.refresh_dividend_history,
     CronTrigger(day_of_week="sat", hour=10, minute=30, timezone=_TZ)),
    # Transfer pairing over the day's imports, at 3:30 in the morning.
    ("rematch-transfers", tasks.rematch_transfers,
     CronTrigger(hour=3, minute=30, timezone=_TZ)),
    # Stored files no row owns (abandoned CSV uploads, receipts of deleted
    # transactions), at 4:30 Eastern, after the transfer pass.
    ("sweep-orphaned-files", tasks.sweep_orphaned_files,
     CronTrigger(hour=4, minute=30, timezone=_TZ)),
]

_scheduler: BackgroundScheduler | None = None


def start() -> None:
    """Start the scheduler. Safe to call once per process."""
    global _scheduler
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(timezone=_TZ)
    for job_id, func, trigger in JOBS:
        # A run that overlaps the next one is skipped, not stacked up.
        _scheduler.add_job(func, trigger, id=job_id, max_instances=1, coalesce=True)
    _scheduler.start()
    log.info("scheduler started with %d jobs", len(JOBS))


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None

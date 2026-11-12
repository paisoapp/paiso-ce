"""Fill in fund expense ratios as soon as a fund appears.

The Add Holding form only asks for an expense ratio when a security is first
created, so the nightly ``refresh_security_info`` was
the only thing that filled them: a fund added today read "no expense ratio on
file" on Fee Analysis until the next morning, under a note promising they fill
in automatically.

Yahoo reports one for ETFs and mutual funds alike (index, target-date and
active funds; checked across 32 funds). It reports none for money market
funds, which are typed ``cash`` (a known 0%), or
for funds with no ticker, which only a hand-entered ratio can cover.
"""
import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select

log = logging.getLogger(__name__)

#: Security types that never carry an expense ratio, so are not looked up.
NO_EXPENSE_RATIO_TYPES = ("stock", "cash", "crypto", "stock_option", "fixed_income")


async def fill_expense_ratios(db, securities) -> int:
    """Look up and store the expense ratio of each security that has none.

    Never overwrites a value that is there (a user's own entry wins). Returns
    how many were filled; the caller commits.
    """
    from app.modules.investments.market_data import expense_ratio_pct_from_info, get_ticker_info

    todo = [s for s in securities if s.ticker and s.expense_ratio is None
            and not s.ticker.startswith("CUR:")]
    if not todo:
        return 0
    loop = asyncio.get_running_loop()
    with ThreadPoolExecutor(max_workers=4) as pool:
        infos = await asyncio.gather(*[
            loop.run_in_executor(pool, get_ticker_info, s.ticker) for s in todo
        ])
    filled = 0
    for sec, info in zip(todo, infos):
        er = expense_ratio_pct_from_info(info or {})
        if er is not None:
            sec.expense_ratio = er
            filled += 1
    return filled


async def fill_expense_ratios_for(security_ids: list[int]) -> int:
    """The same, in a session of its own: for a background task after a
    response (Add Holding) or a sync. Best effort, never raises."""
    from app.core.database import task_session
    import app.models  # noqa: F401 — ensure ORM mappers are registered
    from app.models.security import Security

    if not security_ids:
        return 0
    try:
        async with task_session() as db:
            securities = (await db.scalars(
                select(Security).where(Security.id.in_(security_ids))
            )).all()
            filled = await fill_expense_ratios(db, securities)
            await db.commit()
            return filled
    except Exception:
        log.warning("expense ratio lookup failed", exc_info=True)
        return 0

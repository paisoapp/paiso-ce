from datetime import date, timedelta
from typing import Optional

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

log = structlog.get_logger()

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.models.net_worth_snapshot import NetWorthSnapshot
from app.models.user import User
from app.modules.portfolio.breakdown import get_portfolio_breakdown
from app.modules.portfolio.net_worth_history import reconstruct_net_worth
from app.modules.portfolio.summary import get_portfolio_summary

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])


@router.get("/summary")
async def portfolio_summary(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    result = await get_portfolio_summary(user.id, db, background_tasks=background_tasks)

    # Upsert today's snapshot so the trend chart has data
    today = date.today()
    await db.merge(NetWorthSnapshot(
        user_id=user.id,
        snapshot_date=today,
        net_worth=result["net_worth"],
        total_assets=result["total_assets"],
        total_liabilities=result["total_liabilities"],
    ))
    await db.commit()

    return result


@router.get("/breakdown")
async def portfolio_breakdown(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_portfolio_breakdown(user.id, db)


@router.get("/net-worth-intraday")
async def net_worth_intraday(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    """Net worth through the latest market session, for a "Today" range.

    The daily trend has one point per day, so Today was a single dot. Only
    priced holdings move during a session; cash, property, balances and debts
    hold still. So each point is that holding value at the bar, plus one flat
    amount for everything else, and the last point is today's net worth.
    Holdings follow the net-worth rules: what the user excluded is left out.
    """
    from app.api.portfolio_trend import _intraday_trend, _valued_holdings
    from app.models.holding import Holding

    if not user_acct_ids:
        return {"series": [], "session": None}
    holdings = await _valued_holdings(db, [
        Holding.account_id.in_(user_acct_ids),
        Holding.exclude_from_net_worth == False,  # noqa: E712
    ])
    shares: dict[int, float] = {}
    for h in holdings:
        if h.account is not None and h.account.exclude_from_net_worth:
            continue
        shares[h.security_id] = shares.get(h.security_id, 0.0) + float(h.shares or 0)
    if not shares:
        return {"series": [], "session": None}

    today = date.today()
    intraday = await _intraday_trend(db, shares, today, today, "1m", False)
    points = intraday.get("series", [])
    if not points:
        return {"series": [], "session": intraday.get("session")}

    summary = await get_portfolio_summary(user.id, db)
    moving_now = points[-1]["value"]
    still_net = summary["net_worth"] - moving_now
    still_assets = summary["total_assets"] - moving_now
    owed = round(summary["total_liabilities"], 2)
    return {
        "series": [
            {
                "date": p["date"],
                "net_worth": round(still_net + p["value"], 2),
                "total_assets": round(still_assets + p["value"], 2),
                "total_liabilities": owed,
            }
            for p in points
        ],
        "session": intraday.get("session"),
    }


@router.get("/net-worth-trend")
async def net_worth_trend(
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cutoff = date.fromisoformat(date_from) if date_from else date.today() - timedelta(days=365)
    end_date = date.fromisoformat(date_to) if date_to else date.today()

    try:
        series = await reconstruct_net_worth(db, user.id, cutoff, end_date)
    except Exception as exc:
        log.error("portfolio.net_worth_trend_failed", user_id=user.id, error=str(exc), exc_info=True)
        series = []
    return {"series": series}

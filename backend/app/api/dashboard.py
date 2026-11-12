"""Single aggregated dashboard payload."""
import calendar
from datetime import date, timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.models.transaction import Transaction
from app.models.user import User
from app.modules.budgeting.aggregates import get_expenses, get_income, get_spending_by_day
from app.modules.portfolio.summary import get_portfolio_summary

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("")
async def dashboard(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    today = date.today()
    month_start = date(today.year, today.month, 1)

    # Portfolio summary (serves cached prices; warms the cache in the background)
    portfolio = await get_portfolio_summary(user.id, db, background_tasks=background_tasks)

    # This month's income / expenses / top categories come from the Budgeting
    # aggregates, so they exclude transfer-treated categories (card payments,
    # account-to-account moves, security buys/sells) and pending rows exactly
    # as the Budgeting pages do. The old raw sign-based sums counted every
    # card payment as an expense and every incoming transfer as income.
    income = await get_income(db, user.id, month_start, today)
    expenses = await get_expenses(db, user.id, month_start, today)
    income_total = float(income["total"] or 0)
    expense_total = abs(float(expenses["total"] or 0))

    savings_rate = (
        ((income_total - expense_total) / income_total * 100)
        if income_total > 0
        else 0.0
    )

    top_expenses = [
        {"name": r["category_name"], "color": r["color"], "total": abs(r["total"])}
        for r in sorted(expenses["by_category"], key=lambda r: abs(r["total"]), reverse=True)[:5]
    ]

    # Recent transactions
    recent_txns = (await db.execute(
        select(Transaction)
        .where(Transaction.account_id.in_(user_acct_ids))
        .order_by(Transaction.date_posted.desc(), Transaction.id.desc())
        .limit(5)
    )).scalars().all()

    recent = [
        {
            "id": t.id,
            "date": t.date_posted.isoformat(),
            "description": t.description,
            "amount": float(t.amount),
        }
        for t in recent_txns
    ]

    return {
        "net_worth": portfolio["net_worth"],
        "total_assets": portfolio["total_assets"],
        "total_liabilities": portfolio["total_liabilities"],
        "investment_value": portfolio["investment_value"],
        "asset_breakdown": portfolio["asset_breakdown"],
        # The rest of the summary the dashboard widgets draw on, so a widget
        # never has to trigger a second portfolio computation.
        "total_cash": portfolio["total_cash"],
        "property_value": portfolio["property_value"],
        "other_asset_value": portfolio["other_asset_value"],
        "total_cost_basis": portfolio["total_cost_basis"],
        "costed_value": portfolio["costed_value"],
        "total_gain": portfolio["total_gain"],
        "fee_analysis": portfolio["fee_analysis"],
        "monthly_income": income_total,
        "monthly_expenses": expense_total,
        "savings_rate": round(savings_rate, 1),
        "top_expense_categories": top_expenses,
        "recent_transactions": recent,
    }


def _running_totals(by_day: dict[date, float], start: date, last_day: int) -> list[dict]:
    """``[{"day": 1, "total": …}, …]``: spending so far in the month at the
    end of each day, from day 1 through ``last_day``."""
    out, running = [], 0.0
    for day in range(1, last_day + 1):
        running += by_day.get(start.replace(day=day), 0.0)
        out.append({"day": day, "total": round(running, 2)})
    return out


@router.get("/spending-pace")
async def spending_pace(
    month: str | None = Query(None, pattern=r"^\d{4}-\d{2}$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Spending so far this month, day by day, beside the month before.

    ``month`` is ``YYYY-MM`` and defaults to the current month. A past month
    runs to its last day; the current one runs to today. ``previous_to_date``
    is what the month before had spent by the same day of the month (its last
    day, when it is shorter), which is the fair comparison mid-month.
    """
    today = date.today()
    if month:
        try:
            start = date(int(month[:4]), int(month[5:]), 1)
        except ValueError:
            raise HTTPException(status_code=400, detail="That is not a month.")
        if start > today:
            raise HTTPException(status_code=400, detail="That month has not started yet.")
    else:
        start = today.replace(day=1)
    days = calendar.monthrange(start.year, start.month)[1]
    through = today.day if (start.year, start.month) == (today.year, today.month) else days

    prev_end = start - timedelta(days=1)
    prev_start = prev_end.replace(day=1)
    prev_days = prev_end.day

    current = _running_totals(
        await get_spending_by_day(db, user.id, start, start.replace(day=through)), start, through,
    )
    previous = _running_totals(
        await get_spending_by_day(db, user.id, prev_start, prev_end), prev_start, prev_days,
    )
    return {
        "month": start.strftime("%Y-%m"),
        "previous_month": prev_start.strftime("%Y-%m"),
        "days_in_month": days,
        "through_day": through,
        "current": current,
        "previous": previous,
        "total": current[-1]["total"],
        "previous_to_date": previous[min(through, prev_days) - 1]["total"],
        "previous_total": previous[-1]["total"],
    }

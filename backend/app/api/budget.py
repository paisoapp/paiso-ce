from datetime import date
from typing import Annotated, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import local_today
from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.validation import NonNegativeMoney
from app.models.budget import Budget, BudgetLine, BudgetLineAmount
from app.models.user import User
from app.modules.budgeting.aggregates import get_cashflow, get_expenses, get_income, get_transfers
from app.modules.budgeting.plan import (
    active_budget,
    add_months,
    amount_for,
    category_detail,
    category_report,
    compute_recommendations,
    get_history,
    get_progress,
    load_amount_history,
    parse_month,
    set_line_rollover,
    suggested_income,
    trailing_window,
)

router = APIRouter(prefix="/api/budget", tags=["budget"])

# The budget plan (Cash Flow → Budget) is its own entitlement. The section
# flag on the router lets a plan in to cash flow, income, expenses and
# transfers; building a budget and tracking against it takes this one as well.


@router.get("/expenses")
async def budget_expenses(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    compare_from: Optional[date] = Query(None),
    compare_to: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_expenses(db, user.id, date_from, date_to, compare_from, compare_to, account_id)


@router.get("/income")
async def budget_income(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    compare_from: Optional[date] = Query(None),
    compare_to: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_income(db, user.id, date_from, date_to, compare_from, compare_to, account_id)


@router.get("/transfers")
async def budget_transfers(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_transfers(db, user.id, date_from, date_to, account_id)


@router.get("/cashflow")
async def budget_cashflow(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    compare_from: Optional[date] = Query(None),
    compare_to: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_cashflow(db, user.id, date_from, date_to, compare_from, compare_to, account_id)


# ── Budget plan (enrollment + progress) ──────────────────────────────────────
#
# A user can keep several budgets ("profiles") and one of them is active. The
# singular ``/plan`` routes always mean the active one, so everything that
# reads a budget — the Performance tab, the dashboard widget, the report card
# — needs no idea that there may be others. ``/plans`` manages the set.

# Enough to try a few splits side by side; a cap so the list cannot be grown
# without bound.
MAX_BUDGETS = 10
DEFAULT_BUDGET_NAME = "My budget"


#: The most a monthly budget, or one line of it, can be. A trillion
#: dollars was accepted; anything near this is a typo. The app says the same.
MAX_MONTHLY_BUDGET = 10_000_000
BudgetMoney = Annotated[NonNegativeMoney, Field(le=MAX_MONTHLY_BUDGET)]


class BudgetLineIn(BaseModel):
    category_id: int
    amount: BudgetMoney
    bucket: str = "needs"
    rollover_enabled: bool = False
    # Removed from the budget. Only this hides a line: one set to $0 stays
    # on the Budget tab, so a $0 budget can be tracked on purpose.
    hidden: bool = False


class BudgetLineEdit(BaseModel):
    """One change to one line from the Budget tab. Fields left out stay as they are."""
    amount: Optional[BudgetMoney] = None
    # "onward": this month and later; "month": this month only.
    scope: Literal["onward", "month"] = "onward"
    # YYYY-MM the amount applies from; this month when left out. Past months
    # keep the amounts they had.
    month: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}$")
    bucket: Optional[Literal["needs", "wants", "savings"]] = None
    rollover_enabled: Optional[bool] = None
    hidden: Optional[bool] = None


class BudgetAmountsAction(BaseModel):
    """Budget settings: set every amount at once."""
    # "averages": each line to its trailing average; "reset": every line to $0.
    action: Literal["averages", "reset"]
    scope: Literal["onward", "month"] = "onward"
    month: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}$")


class BudgetLineOrder(BaseModel):
    category_id: int
    bucket: Literal["needs", "wants", "savings"]
    position: int = Field(ge=0)


class BudgetPlanIn(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    total_target: Optional[BudgetMoney] = None
    income_basis: str = "manual"
    trailing_months: int = Field(3, ge=1, le=36)
    # Whether categories start with rollover on.
    rollover_default: bool = False
    lines: list[BudgetLineIn] = []


class BudgetConfigIn(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    total_target: Optional[BudgetMoney] = None
    income_basis: Optional[str] = None
    trailing_months: Optional[int] = Field(None, ge=1, le=36)
    # The budget-wide rollover switch. Given, it also switches every
    # category on the budget to match, from this month.
    rollover_default: Optional[bool] = None
    # When given, replaces the allocation in the same transaction as the
    # settings above, so a new total and the lines that add up to it are saved
    # together or not at all.
    lines: Optional[list[BudgetLineIn]] = None


class BudgetProfileIn(BaseModel):
    name: Optional[str] = Field(None, max_length=60)
    # Start from a copy of this budget (total, settings and lines). Omitted,
    # the new budget starts from the fields below.
    copy_from: Optional[int] = None
    total_target: Optional[BudgetMoney] = None
    income_basis: str = "manual"
    trailing_months: int = Field(3, ge=1, le=36)
    rollover_default: bool = False
    lines: list[BudgetLineIn] = []
    # Switch to the new budget straight away.
    activate: bool = True


def _first_of_this_month() -> date:
    today = local_today()
    return date(today.year, today.month, 1)


def _clean_name(name: Optional[str]) -> Optional[str]:
    name = (name or "").strip()
    return name or None


async def _serialize_plan(db: AsyncSession, budget: Budget) -> dict:
    lines = (await db.scalars(
        select(BudgetLine)
        .where(BudgetLine.budget_id == budget.id, BudgetLine.hidden.is_(False))
        .order_by(BudgetLine.id)
    )).all()
    return {
        "enrolled": True,
        "id": budget.id,
        "name": budget.name,
        "is_active": bool(budget.is_active),
        "total_target": float(budget.total_target) if budget.total_target is not None else None,
        "income_basis": budget.income_basis,
        "trailing_months": budget.trailing_months,
        "start_month": budget.start_month.isoformat(),
        "rollover_default": bool(budget.rollover_default),
        "lines": [
            {
                "category_id": ln.category_id,
                "amount": float(ln.amount or 0),
                "bucket": ln.bucket,
                "rollover_enabled": bool(ln.rollover_enabled),
            }
            for ln in lines
        ],
    }


async def _assert_categories_owned(db: AsyncSession, user_id: int, category_ids) -> None:
    """Every budget-line category must belong to this user.

    ``budget_line.category_id`` is a real FK, so the database accepted any
    user's category id — a cross-tenant reference, an existence oracle, and a
    row that another user's category-delete would cascade away. Every other
    endpoint that takes a category_id already checks ownership; this brings the
    budget lines in line."""
    from app.models.transaction import Category

    ids = {c for c in category_ids if c is not None}
    if not ids:
        return
    owned = set((await db.scalars(
        select(Category.id).where(Category.user_id == user_id, Category.id.in_(ids))
    )).all())
    if ids - owned:
        raise HTTPException(status_code=404, detail="Category not found.")


async def _set_amount_from(
    db: AsyncSession,
    line: BudgetLine,
    history: list[BudgetLineAmount],
    amount: float,
    month: date,
    start_month: date,
    scope: str = "onward",
) -> None:
    """Record `amount` for `line` from `month` on (``onward``), or for
    `month` alone (``month``), leaving earlier months as they were.
    ``BudgetLine.amount`` follows the amount in force this month."""
    current = amount_for(line, history, month.year, month.month, start_month)
    if not history and month > start_month:
        # Saved before amounts were stored by month: its one amount was in
        # force from the start, so write that down before changing it.
        db.add(BudgetLineAmount(
            user_id=line.user_id, budget_line_id=line.id, month=start_month,
            amount=float(line.amount or 0), scope="onward",
        ))
    override = next((r for r in history if r.scope == "month" and r.month == month), None)
    if scope == "month":
        if override is not None:
            override.amount = amount
        else:
            db.add(BudgetLineAmount(
                user_id=line.user_id, budget_line_id=line.id, month=month, amount=amount, scope="month",
            ))
        if month == _first_of_this_month():
            line.amount = amount
        return
    # "This month and later" replaces a one-month change made for this month.
    if override is not None:
        await db.delete(override)
        history.remove(override)
    if month <= _first_of_this_month():
        line.amount = amount
    if history and override is None and abs(current - amount) < 0.005:
        return
    row = next((r for r in history if r.scope == "onward" and r.month == month), None)
    if row is not None:
        row.amount = amount
    else:
        db.add(BudgetLineAmount(
            user_id=line.user_id, budget_line_id=line.id, month=month, amount=amount, scope="onward",
        ))


async def _hide_from(
    db: AsyncSession,
    line: BudgetLine,
    history: list[BudgetLineAmount],
    month: date,
    start_month: date,
) -> None:
    """Take `line` off the budget from `month` on, keeping the amount it had.

    Writing $0 "from this month on" replaced the line's own row when it was
    set in the same month, as every line is in a budget's first month, so the
    amount was lost and Add a category brought it back at $0. A $0 for `month` alone plus $0 from the next month leaves that
    row in place; later plans are dropped, since the line is gone.
    """
    line.hidden = True
    await _drop_after(db, history, month)
    await _set_amount_from(db, line, history, 0.0, month, start_month, scope="month")
    ny, nm = add_months(month.year, month.month, 1)
    row = BudgetLineAmount(
        user_id=line.user_id, budget_line_id=line.id, month=date(ny, nm, 1), amount=0, scope="onward",
    )
    db.add(row)
    history.append(row)


async def _drop_after(db: AsyncSession, history: list[BudgetLineAmount], month: date) -> None:
    """Delete `history` rows for months after `month`."""
    for row in [r for r in history if r.month > month]:
        await db.delete(row)
        history.remove(row)


async def _unhide_from(
    db: AsyncSession,
    line: BudgetLine,
    history: list[BudgetLineAmount],
    amount: Optional[float],
    month: date,
    start_month: date,
    scope: str = "onward",
) -> None:
    """Put a hidden `line` back from `month`, at `amount` or, without one, at
    the last amount it had."""
    line.hidden = False
    await _drop_after(db, history, month)
    if amount is None:
        nonzero = [r for r in history if r.scope == "onward" and float(r.amount) > 0]
        amount = float(nonzero[-1].amount) if nonzero else 0.0
    if scope == "onward":
        # Clear the $0 for this month that hiding wrote before setting the amount.
        await _set_amount_from(db, line, history, amount, month, start_month, scope="onward")
    else:
        await _set_amount_from(db, line, history, amount, month, start_month, scope="month")


async def _save_lines(db: AsyncSession, user_id: int, budget: Budget, lines: list[BudgetLineIn]) -> None:
    """Make the budget's allocation match `lines` from this month on.

    Lines are matched by category. A changed amount is recorded from this
    month on, so earlier months and the rollover they carried keep the amounts
    they had. A category left out is hidden and set to zero from this month,
    not deleted, so its history stays. This used to delete every line and add
    them again, which rewrote every past month.
    """
    await _assert_categories_owned(db, user_id, [ln.category_id for ln in lines])
    month = max(_first_of_this_month(), budget.start_month)
    existing = {
        ln.category_id: ln
        for ln in (await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == budget.id))).all()
    }
    history = await load_amount_history(db, list(existing.values()))
    kept: set[int] = set()
    for ln_in in lines:
        kept.add(ln_in.category_id)
        line = existing.get(ln_in.category_id)
        if line is None:
            line = BudgetLine(
                user_id=user_id, budget_id=budget.id, category_id=ln_in.category_id,
                amount=0 if ln_in.hidden else ln_in.amount, bucket=ln_in.bucket,
            )
            set_line_rollover(line, ln_in.rollover_enabled, month, budget.start_month)
            db.add(line)
            await db.flush()
            existing[ln_in.category_id] = line
            line.hidden = ln_in.hidden
            # New to this budget: it plans nothing before this month.
            db.add(BudgetLineAmount(
                user_id=user_id, budget_line_id=line.id, month=month,
                amount=0 if ln_in.hidden else ln_in.amount, scope="onward",
            ))
            continue
        line.bucket = ln_in.bucket
        set_line_rollover(line, ln_in.rollover_enabled, month, budget.start_month)
        line_history = history.setdefault(line.id, [])
        if ln_in.hidden:
            if not line.hidden:
                await _hide_from(db, line, line_history, month, budget.start_month)
        elif line.hidden:
            await _unhide_from(db, line, line_history, float(ln_in.amount), month, budget.start_month)
        else:
            await _set_amount_from(db, line, line_history, float(ln_in.amount), month, budget.start_month)
    for category_id, line in existing.items():
        if category_id not in kept and not line.hidden:
            await _hide_from(db, line, history.setdefault(line.id, []), month, budget.start_month)


async def _user_budgets(db: AsyncSession, user_id: int) -> list[Budget]:
    return list((await db.scalars(
        select(Budget).where(Budget.user_id == user_id).order_by(Budget.id)
    )).all())


async def _own_budget(db: AsyncSession, user_id: int, budget_id: int) -> Budget:
    budget = await db.scalar(
        select(Budget).where(Budget.id == budget_id, Budget.user_id == user_id)
    )
    if budget is None:
        raise HTTPException(status_code=404, detail="Budget not found.")
    return budget


async def _make_active(db: AsyncSession, user_id: int, budget: Budget) -> None:
    """Switch the user to `budget`. The others are switched off first and
    flushed, since the database allows only one active row per user."""
    await db.execute(
        update(Budget)
        .where(Budget.user_id == user_id, Budget.id != budget.id, Budget.is_active.is_(True))
        .values(is_active=False)
    )
    await db.flush()
    budget.is_active = True


@router.get("/plan")
async def get_plan(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budget = await active_budget(db, user.id)
    if budget is None:
        return {"enrolled": False}
    return await _serialize_plan(db, budget)


@router.post("/plan")
async def create_plan(
    body: BudgetPlanIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if await active_budget(db, user.id) is not None:
        raise HTTPException(status_code=409, detail="Budget already exists; use PUT to update.")
    # Validate ownership before creating anything, so a foreign category id
    # leaves no partial budget behind.
    await _assert_categories_owned(db, user.id, [ln.category_id for ln in body.lines])

    budget = Budget(
        user_id=user.id,
        name=_clean_name(body.name) or DEFAULT_BUDGET_NAME,
        is_active=True,
        total_target=body.total_target,
        income_basis=body.income_basis,
        trailing_months=body.trailing_months,
        rollover_default=body.rollover_default,
        start_month=_first_of_this_month(),
    )
    db.add(budget)
    await db.flush()
    await _save_lines(db, user.id, budget, body.lines)
    await db.commit()
    await db.refresh(budget)
    return await _serialize_plan(db, budget)


@router.put("/plan")
async def update_plan(
    body: BudgetConfigIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budget = await active_budget(db, user.id)
    if budget is None:
        raise HTTPException(status_code=404, detail="No budget to update.")
    if _clean_name(body.name) is not None:
        budget.name = _clean_name(body.name)
    if body.total_target is not None:
        budget.total_target = body.total_target
    if body.income_basis is not None:
        budget.income_basis = body.income_basis
    if body.trailing_months is not None:
        budget.trailing_months = body.trailing_months
    if body.rollover_default is not None:
        budget.rollover_default = body.rollover_default
        # Every category follows the switch, counting from this month.
        month = max(_first_of_this_month(), budget.start_month)
        for line in (await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == budget.id))).all():
            set_line_rollover(line, body.rollover_default, month, budget.start_month)
    if body.lines is not None:
        await _save_lines(db, user.id, budget, body.lines)
    await db.commit()
    await db.refresh(budget)
    return await _serialize_plan(db, budget)


@router.put("/plan/lines")
async def upsert_lines(
    body: list[BudgetLineIn],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budget = await active_budget(db, user.id)
    if budget is None:
        raise HTTPException(status_code=404, detail="No budget; enroll first.")
    # The full allocation set (the editor saves all lines at once).
    await _save_lines(db, user.id, budget, body)
    await db.commit()
    await db.refresh(budget)
    return await _serialize_plan(db, budget)


@router.patch("/plan/lines/{category_id}")
async def edit_line(
    category_id: int,
    body: BudgetLineEdit,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Change one line from the Budget tab: its amount for this month
    only or from this month on, its bucket, its rollover, or whether it is in
    the budget at all. A category with no line yet gets one. Returns the
    month's progress."""
    from app.models.transaction import Category
    from app.modules.budgeting.benchmarks import default_bucket_for

    budget = await active_budget(db, user.id)
    if budget is None:
        raise HTTPException(status_code=404, detail="No budget; enroll first.")
    await _assert_categories_owned(db, user.id, [category_id])
    this_month = _first_of_this_month()
    month = this_month
    if body.month:
        y, m = parse_month(body.month)
        month = date(y, m, 1)
    if month < this_month:
        raise HTTPException(status_code=422, detail="Past months keep the amounts they had.")
    month = max(month, budget.start_month)

    line = await db.scalar(
        select(BudgetLine).where(BudgetLine.budget_id == budget.id, BudgetLine.category_id == category_id)
    )
    if line is None:
        cat = await db.get(Category, category_id)
        line = BudgetLine(
            user_id=user.id, budget_id=budget.id, category_id=category_id, amount=0,
            bucket=body.bucket or default_bucket_for(cat.name, cat.treatment),
        )
        # A category added later starts as the budget-wide switch says.
        set_line_rollover(line, bool(budget.rollover_default), month, budget.start_month)
        db.add(line)
        await db.flush()
        # New to this budget: it plans nothing before this month.
        first_row = BudgetLineAmount(
            user_id=user.id, budget_line_id=line.id, month=month, amount=0, scope="onward",
        )
        db.add(first_row)
        history = [first_row]
    else:
        history = (await load_amount_history(db, [line])).get(line.id, [])

    if body.bucket is not None and body.bucket != line.bucket:
        # Moved from the menu, it goes to the end of its new bucket.
        last = await db.scalar(
            select(func.max(BudgetLine.position))
            .where(BudgetLine.budget_id == budget.id, BudgetLine.bucket == body.bucket)
        )
        line.bucket = body.bucket
        line.position = (last or 0) + 1
    if body.rollover_enabled is not None:
        set_line_rollover(line, body.rollover_enabled, month, budget.start_month)

    amount = None if body.amount is None else float(body.amount)
    if body.hidden:
        if not line.hidden:
            await _hide_from(db, line, history, month, budget.start_month)
    elif body.hidden is False and line.hidden:
        # Back with the amount given, or the last amount it had.
        await _unhide_from(db, line, history, amount, month, budget.start_month, body.scope)
    elif amount is not None:
        await _set_amount_from(db, line, history, amount, month, budget.start_month, body.scope)
    await db.commit()
    return await get_progress(db, user.id, f"{month.year:04d}-{month.month:02d}")


@router.post("/plan/amounts")
async def set_all_amounts(
    body: BudgetAmountsAction,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Fill every line from its average, or reset every line to $0.

    Either applies from the month given (this month by default) on, or to
    that month only; earlier months keep the amounts they had. Fill covers
    the lines on the budget; Reset also brings back removed ones, at $0.
    Returns the month's progress."""
    budget = await active_budget(db, user.id)
    if budget is None:
        raise HTTPException(status_code=404, detail="No budget; enroll first.")
    this_month = _first_of_this_month()
    month = this_month
    if body.month:
        y, m = parse_month(body.month)
        month = date(y, m, 1)
    if month < this_month:
        raise HTTPException(status_code=422, detail="Past months keep the amounts they had.")
    month = max(month, budget.start_month)

    lines = list((await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == budget.id))).all())
    history = await load_amount_history(db, lines)
    averages: dict[int, float] = {}
    if body.action == "averages":
        recs = await compute_recommendations(db, user.id, float(budget.total_target or 0), budget.trailing_months)
        averages = {r["category_id"]: float(r["trailing_avg"]) for r in recs}
    for line in lines:
        if body.action == "averages":
            if line.hidden:
                continue
            amount = averages.get(line.category_id, 0.0)
        elif line.hidden:
            await _unhide_from(db, line, history.setdefault(line.id, []), 0.0, month, budget.start_month, body.scope)
            continue
        else:
            amount = 0.0
        await _set_amount_from(
            db, line, history.setdefault(line.id, []), amount, month, budget.start_month, body.scope,
        )
    await db.commit()
    return await get_progress(db, user.id, f"{month.year:04d}-{month.month:02d}")


@router.put("/plan/order")
async def reorder_lines(
    body: list[BudgetLineOrder],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Each line's bucket and its place in it, after a drag on the Budget tab."""
    budget = await active_budget(db, user.id)
    if budget is None:
        raise HTTPException(status_code=404, detail="No budget; enroll first.")
    lines = {
        ln.category_id: ln
        for ln in (await db.scalars(select(BudgetLine).where(BudgetLine.budget_id == budget.id))).all()
    }
    for item in body:
        line = lines.get(item.category_id)
        if line is None:
            raise HTTPException(status_code=404, detail="Category not found.")
        line.bucket = item.bucket
        line.position = item.position
    await db.commit()
    return {"ok": True}


@router.get("/plan/category/{category_id}")
async def plan_category_detail(
    category_id: int,
    month: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}$"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Six months of spending and this month's transactions for one category,
    for the Allocated and Used pop-ups on the Budget tab."""
    await _assert_categories_owned(db, user.id, [category_id])
    return await category_detail(db, user.id, category_id, month)


@router.get("/plan/category/{category_id}/report")
async def plan_category_report(
    category_id: int,
    date_from: date = Query(...),
    date_to: date = Query(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Month by month allocated, used and rollover for one category, and its
    amount history, for the category's side drawer."""
    if date_to < date_from:
        raise HTTPException(status_code=422, detail="The range ends before it starts.")
    await _assert_categories_owned(db, user.id, [category_id])
    return await category_report(db, user.id, category_id, date_from, date_to)


@router.delete("/plan", status_code=204)
async def delete_plan(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete the active budget. Another one, if there is one, takes over."""
    budget = await active_budget(db, user.id)
    if budget is not None:
        await _delete_budget(db, user.id, budget)
        await db.commit()


async def _delete_budget(db: AsyncSession, user_id: int, budget: Budget) -> None:
    was_active = bool(budget.is_active)
    await db.delete(budget)
    await db.flush()
    if was_active:
        # Fall back to the most recently created of what is left, so deleting
        # the budget in use does not silently un-enroll someone who has others.
        rest = await _user_budgets(db, user_id)
        if rest:
            rest[-1].is_active = True


@router.get("/plans")
async def list_plans(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budgets = await _user_budgets(db, user.id)
    allocated = dict((await db.execute(
        select(BudgetLine.budget_id, func.coalesce(func.sum(BudgetLine.amount), 0))
        .where(BudgetLine.user_id == user.id)
        .group_by(BudgetLine.budget_id)
    )).all())
    return {
        "max": MAX_BUDGETS,
        "plans": [
            {
                "id": b.id,
                "name": b.name,
                "is_active": bool(b.is_active),
                "total_target": float(b.total_target) if b.total_target is not None else None,
                "allocated": float(allocated.get(b.id, 0) or 0),
            }
            for b in budgets
        ],
    }


@router.post("/plans")
async def create_profile(
    body: BudgetProfileIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    existing = await _user_budgets(db, user.id)
    if len(existing) >= MAX_BUDGETS:
        raise HTTPException(status_code=409, detail=f"You can keep up to {MAX_BUDGETS} budgets. Delete one to add another.")

    source = await _own_budget(db, user.id, body.copy_from) if body.copy_from is not None else None
    budget = Budget(
        user_id=user.id,
        name=_clean_name(body.name) or (f"{source.name} copy"[:60] if source else f"Budget {len(existing) + 1}"),
        # Switched on below, after the current one is switched off.
        is_active=False,
        total_target=source.total_target if source else body.total_target,
        income_basis=source.income_basis if source else body.income_basis,
        trailing_months=source.trailing_months if source else body.trailing_months,
        rollover_default=source.rollover_default if source else body.rollover_default,
        # Rollover accrues from the month a budget starts, and a new budget
        # starts now: it has no history of its own to have saved against.
        start_month=_first_of_this_month(),
    )
    db.add(budget)
    await db.flush()
    if source is not None:
        # The copy starts from the source's lines as they stand this month.
        source_lines = (await db.scalars(
            select(BudgetLine)
            .where(BudgetLine.budget_id == source.id, BudgetLine.hidden.is_(False))
            .order_by(BudgetLine.id)
        )).all()
        await _save_lines(db, user.id, budget, [
            BudgetLineIn(
                category_id=ln.category_id, amount=float(ln.amount or 0),
                bucket=ln.bucket, rollover_enabled=bool(ln.rollover_enabled),
            )
            for ln in source_lines
        ])
    else:
        await _save_lines(db, user.id, budget, body.lines)
    if body.activate or not existing:
        await _make_active(db, user.id, budget)
    await db.commit()
    await db.refresh(budget)
    return await _serialize_plan(db, budget)


@router.post("/plans/{budget_id}/activate")
async def activate_profile(
    budget_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budget = await _own_budget(db, user.id, budget_id)
    await _make_active(db, user.id, budget)
    await db.commit()
    await db.refresh(budget)
    return await _serialize_plan(db, budget)


@router.delete("/plans/{budget_id}", status_code=204)
async def delete_profile(
    budget_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    budget = await _own_budget(db, user.id, budget_id)
    await _delete_budget(db, user.id, budget)
    await db.commit()


@router.get("/plan/recommendations")
async def plan_recommendations(
    income: float = Query(0.0),
    trailing_months: int = Query(3),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await compute_recommendations(db, user.id, income, trailing_months)


@router.get("/plan/suggested-income")
async def plan_suggested_income(
    trailing_months: int = Query(3),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    start, end = trailing_window(trailing_months)
    return {
        "monthly_income": await suggested_income(db, user.id, trailing_months),
        # The months averaged, so the screen can name them.
        "from": start.isoformat(),
        "to": end.isoformat(),
    }


@router.get("/plan/history")
async def plan_history(
    months: int = Query(12, ge=1, le=24),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    return await get_history(db, user.id, months)


@router.get("/plan/progress")
async def plan_progress(
    month: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Validate month format early (raises ValueError → 422-ish if malformed).
    if month:
        parse_month(month)
    return await get_progress(db, user.id, month)

"""Budget-plan logic: recommendations and monthly progress.

Reuses the account-scoping helper from ``aggregates`` but computes category
*actuals* its own way, because a budget line is a claim on real spending:

* an expense category counts what left the user's accounts net of refunds in
  that category;
* a transfer-tree goal category (Savings, Investments, Loan Payment …) counts
  only the leg where the money leaves. A move from checking into savings has
  two rows — the checking debit and the savings credit — and only the debit is
  the user putting money aside. The same holds for a mortgage payment and the
  loan account's "PAYMENT RECEIVED";
* transfers that only shuffle money already counted elsewhere (card payments,
  account-to-account moves, refunds) are not budgetable at all — see
  ``benchmarks.NOT_BUDGETABLE``.

Pending rows never count, as in ``aggregates``.
"""
import math
from calendar import monthrange
from datetime import date
from typing import Optional

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import local_today
from app.models.budget import Budget, BudgetLine, BudgetLineAmount
from app.models.transaction import Category, Transaction
from app.modules.budgeting.aggregates import _NOT_LOAN_CREDIT, _NOT_PENDING, _get_account_ids, get_income
from app.modules.budgeting.benchmarks import benchmark_for, default_bucket_for, is_budgetable


async def active_budget(db: AsyncSession, user_id: int) -> Optional[Budget]:
    """The budget the user is currently living by, if they have set one up."""
    return await db.scalar(
        select(Budget).where(Budget.user_id == user_id, Budget.is_active.is_(True))
    )


# ── Date helpers ─────────────────────────────────────────────────────────────

def month_bounds(year: int, month: int) -> tuple[date, date]:
    """First and last day of the given calendar month."""
    last = monthrange(year, month)[1]
    return date(year, month, 1), date(year, month, last)


def parse_month(month: Optional[str]) -> tuple[int, int]:
    """Parse 'YYYY-MM' into (year, month); default to the current month."""
    if month:
        y, m = month.split("-")
        return int(y), int(m)
    today = local_today()
    return today.year, today.month


def add_months(year: int, month: int, delta: int) -> tuple[int, int]:
    idx = (year * 12 + (month - 1)) + delta
    return idx // 12, idx % 12 + 1


def months_between(start: date, year: int, month: int) -> int:
    """Whole months from `start`'s month up to (but excluding) the given month."""
    return (year * 12 + (month - 1)) - (start.year * 12 + (start.month - 1))


# ── Actuals ──────────────────────────────────────────────────────────────────

async def _category_spend_totals(
    db: AsyncSession,
    acct_ids: list[int],
    date_from: date,
    date_to: date,
) -> dict[int, float]:
    """category_id → money spent (or put aside) in [from, to], as a positive number.

    Expense categories net their refunds (a returned purchase undoes the
    spend); transfer-tree categories count outflows only, so the two legs of a
    move are never added together. A category can come out negative when its
    refunds outweigh its purchases; callers clip at the line level.

    Excludes uncategorized (NULL category) rows — those are surfaced separately
    as 'unbudgeted' spend.
    """
    if not acct_ids:
        return {}
    spent = case(
        (Category.treatment == "transfer",
         case((Transaction.amount < 0, -Transaction.amount), else_=0)),
        else_=-Transaction.amount,
    )
    rows = (await db.execute(
        select(Transaction.category_id, func.sum(spent).label("total"))
        .join(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.account_id.in_(acct_ids),
            Transaction.date_posted >= date_from,
            Transaction.date_posted <= date_to,
            _NOT_PENDING,
            _NOT_LOAN_CREDIT,
        )
        .group_by(Transaction.category_id)
    )).all()
    return {r.category_id: float(r.total or 0) for r in rows}


async def _category_spend_by_month(
    db: AsyncSession,
    acct_ids: list[int],
    date_from: date,
    date_to: date,
) -> dict[tuple[int, int], dict[int, float]]:
    """(year, month) → ``_category_spend_totals`` for that month, in one query.

    Rollover carries month by month, and only in months a line was on the
    budget, so it needs each month's spending, not the window's.
    """
    if not acct_ids:
        return {}
    spent = case(
        (Category.treatment == "transfer",
         case((Transaction.amount < 0, -Transaction.amount), else_=0)),
        else_=-Transaction.amount,
    )
    rows = (await db.execute(
        select(Transaction.category_id, Transaction.date_posted, spent.label("spent"))
        .join(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.account_id.in_(acct_ids),
            Transaction.date_posted >= date_from,
            Transaction.date_posted <= date_to,
            _NOT_PENDING,
            _NOT_LOAN_CREDIT,
        )
    )).all()
    out: dict[tuple[int, int], dict[int, float]] = {}
    for r in rows:
        month = out.setdefault((r.date_posted.year, r.date_posted.month), {})
        month[r.category_id] = month.get(r.category_id, 0.0) + float(r.spent or 0)
    return out


async def _user_categories(db: AsyncSession, user_id: int) -> dict[int, Category]:
    rows = (await db.scalars(
        select(Category).where(Category.user_id == user_id)
    )).all()
    return {c.id: c for c in rows}


def _children_of(cats: dict[int, Category]) -> dict[int, list[int]]:
    out: dict[int, list[int]] = {}
    for c in cats.values():
        if c.parent_id is not None:
            out.setdefault(c.parent_id, []).append(c.id)
    return out


def _subtree_total(cat_id: int, totals: dict[int, float], children: dict[int, list[int]]) -> float:
    """Actual for a category = its own total plus all direct children's totals.

    Never below zero: a month of net refunds is no spending, not negative
    spending that would flatter the rest of the budget.
    """
    total = totals.get(cat_id, 0.0)
    for child_id in children.get(cat_id, []):
        total += totals.get(child_id, 0.0)
    return max(total, 0.0)


def _budgetable_lines(lines: list[BudgetLine], cats: dict[int, Category]) -> list[BudgetLine]:
    """Lines a month is graded on.

    Budgets saved before card payments and plain transfers were excluded can
    still hold such a line; it is ignored rather than counted, and the editor
    no longer offers it, so the next save drops it. A hidden one is kept: it
    was taken off the budget when its category moved to a group that cannot be
    budgeted, and the months before keep it.
    """
    out = []
    for ln in lines:
        c = cats.get(ln.category_id)
        if c is None or ln.hidden or is_budgetable(c.name, c.treatment):
            out.append(ln)
    return out


# ── Amounts by month ──────────────────────────────────────────────────

async def load_amount_history(db: AsyncSession, lines: list[BudgetLine]) -> dict[int, list[BudgetLineAmount]]:
    """line id → its ``BudgetLineAmount`` rows, oldest first."""
    ids = [ln.id for ln in lines]
    if not ids:
        return {}
    rows = (await db.scalars(
        select(BudgetLineAmount)
        .where(BudgetLineAmount.budget_line_id.in_(ids))
        .order_by(BudgetLineAmount.month, BudgetLineAmount.id)
    )).all()
    out: dict[int, list[BudgetLineAmount]] = {}
    for row in rows:
        out.setdefault(row.budget_line_id, []).append(row)
    return out


def amount_for(
    line: BudgetLine,
    history: list[BudgetLineAmount],
    year: int,
    month: int,
    start_month: date,
) -> float:
    """The amount `line` plans for one month. The only place that answers it.

    A ``month`` row for that month wins; otherwise the latest ``onward`` row on
    or before it. A month before the line's first ``onward`` row plans nothing,
    unless it is also before the budget started: such a month is only shown for
    comparison, against the line's first amount. A line with no rows (saved
    before amounts were stored by month) plans its one amount every month.
    """
    if not history:
        return float(line.amount or 0)
    first = date(year, month, 1)
    onward: Optional[BudgetLineAmount] = None
    for row in history:
        if row.scope == "month":
            if row.month == first:
                return float(row.amount)
            continue
        if row.month <= first and (onward is None or row.month >= onward.month):
            onward = row
    if onward is not None:
        return float(onward.amount)
    earliest = min((r for r in history if r.scope == "onward"), key=lambda r: r.month, default=None)
    if earliest is not None and first < start_month:
        return float(earliest.amount)
    return 0.0


def _planned_lines(
    lines: list[BudgetLine],
    history: dict[int, list[BudgetLineAmount]],
    year: int,
    month: int,
    start_month: date,
) -> list[tuple[BudgetLine, float]]:
    """The lines a month is graded on, each with the amount it plans for it.

    A hidden line drops out from the month it was hidden, when its amount went
    to zero; the months before keep it, since they planned money for it. A
    line added after the budget started is left out of the months before it.
    """
    out = []
    for ln in lines:
        amount = planned_amount(ln, history.get(ln.id, []), year, month, start_month)
        if amount is not None:
            out.append((ln, amount))
    return out


def planned_amount(
    line: BudgetLine,
    line_history: list[BudgetLineAmount],
    year: int,
    month: int,
    start_month: date,
) -> Optional[float]:
    """What `line` planned for a month, or None when it was not on the budget
    then: before it was added, or from the month it was removed."""
    amount = amount_for(line, line_history, year, month, start_month)
    if amount == 0:
        first = date(year, month, 1)
        added = min((r.month for r in line_history if r.scope == "onward"), default=None)
        not_yet_added = added is not None and start_month <= first < added
        if line.hidden or not_yet_added:
            return None
    return amount


def rollover_origin(line: BudgetLine, start_month: date) -> date:
    """The first month a line's rollover counts for: the month it was turned
    on, never before the budget started."""
    return max(start_month, line.rollover_from) if line.rollover_from else start_month


def set_line_rollover(line: BudgetLine, on: bool, month: date, start_month: date) -> None:
    """Turn a line's rollover on or off. Turned on, it counts from `month`;
    turned off and on again, it starts afresh. On from the budget's
    first month, it needs no month of its own: it counts from the start."""
    if on and not line.rollover_enabled:
        month = month.replace(day=1)
        line.rollover_from = month if month > start_month else None
    elif not on:
        line.rollover_from = None
    line.rollover_enabled = int(on)


def line_carryover(
    line: BudgetLine,
    line_history: list[BudgetLineAmount],
    spend_by_month: dict[tuple[int, int], dict[int, float]],
    children: dict[int, list[int]],
    start_month: date,
    year: int,
    month: int,
) -> float:
    """Rollover carried into (year, month): each earlier month from the
    month rollover was turned on (or the budget's start), at the amount it
    had then, less what was spent then.
    Both ways: money left over adds, overspending subtracts.

    Only months the line was on the budget count. Summing the whole window
    charged a category added later with every dollar spent there before it
    had a line.
    """
    carried = 0.0
    origin = rollover_origin(line, start_month)
    for i in range(max(0, months_between(origin, year, month))):
        y, m = add_months(origin.year, origin.month, i)
        planned = planned_amount(line, line_history, y, m, start_month)
        if planned is None:
            continue
        carried += planned - _subtree_total(line.category_id, spend_by_month.get((y, m), {}), children)
    return round(carried, 2)


# ── Recommendations (enrollment) ─────────────────────────────────────────────

async def compute_recommendations(
    db: AsyncSession,
    user_id: int,
    income: float,
    trailing_months: int = 3,
) -> list[dict]:
    """Per spendable/savable category: trailing average + benchmark suggestion.

    Returns budgetable leaf categories (expenses and transfer-tree goals, never
    card payments or plain transfers), ordered by trailing average descending.
    Amounts are whole dollars: a budget is set in dollars, not cents.
    """
    acct_ids = await _get_account_ids(db, user_id)
    cats = await _user_categories(db, user_id)
    children = _children_of(cats)

    today = local_today()
    ty, tm = add_months(today.year, today.month, -trailing_months)
    start = date(ty, tm, 1)
    py, pm = add_months(today.year, today.month, -1)
    end = month_bounds(py, pm)[1]

    totals = await _category_spend_totals(db, acct_ids, start, end)

    recs: list[dict] = []
    for c in cats.values():
        # Only leaf categories that represent spending or savings goals.
        if c.parent_id is None:
            continue
        if c.treatment not in ("expense", "transfer"):
            continue
        if not is_budgetable(c.name, c.treatment):
            continue
        if c.name == "Uncategorized":
            continue
        subtotal = _subtree_total(c.id, totals, children)
        # Half up, as the Budget tab's Last month and Avg chips round.
        trailing_avg = float(math.floor(subtotal / max(trailing_months, 1) + 0.5))
        recs.append({
            "category_id": c.id,
            "name": c.name,
            "color": c.color,
            "bucket": default_bucket_for(c.name, c.treatment),
            "trailing_avg": trailing_avg,
            "benchmark": benchmark_for(c.name, income),
        })

    recs.sort(key=lambda r: r["trailing_avg"], reverse=True)
    return recs


# ── Monthly progress (dashboard) ─────────────────────────────────────────────

async def get_progress(
    db: AsyncSession,
    user_id: int,
    month: Optional[str] = None,
) -> dict:
    """Per-line progress for `month` (YYYY-MM) plus bucket rollups and headline."""
    budget = await active_budget(db, user_id)
    if budget is None:
        return {"enrolled": False}

    lines = (await db.scalars(
        select(BudgetLine).where(BudgetLine.budget_id == budget.id)
    )).all()

    acct_ids = await _get_account_ids(db, user_id)
    cats = await _user_categories(db, user_id)
    children = _children_of(cats)
    lines = _budgetable_lines(lines, cats)
    history = await load_amount_history(db, lines)

    year, mon = parse_month(month)
    m_from, m_to = month_bounds(year, mon)
    py, pm = add_months(year, mon, -1)
    p_from, p_to = month_bounds(py, pm)

    cur_totals = await _category_spend_totals(db, acct_ids, m_from, m_to)
    prev_totals = await _category_spend_totals(db, acct_ids, p_from, p_to)

    # ── Pacing context (only meaningful for the live, current month) ──────────
    today = local_today()
    is_current = (year, mon) == (today.year, today.month)
    is_past = (year, mon) < (today.year, today.month)
    days_in_month = monthrange(year, mon)[1]
    if is_current:
        day_of_month = today.day
        days_remaining = days_in_month - day_of_month
        month_pct_elapsed = round(day_of_month / days_in_month, 4)
    elif is_past:
        day_of_month = days_in_month
        days_remaining = 0
        month_pct_elapsed = 1.0
    else:  # future month
        day_of_month = 0
        days_remaining = days_in_month
        month_pct_elapsed = 0.0

    # ── Rollover accrual window: enrollment month → end of previous month ─────
    elapsed_before = max(0, months_between(budget.start_month, year, mon))
    spend_by_month: dict[tuple[int, int], dict[int, float]] = {}
    if elapsed_before > 0 and any(ln.rollover_enabled for ln in lines):
        spend_by_month = await _category_spend_by_month(db, acct_ids, budget.start_month, p_to)

    line_rows: list[dict] = []
    buckets = {b: {"budgeted": 0.0, "actual": 0.0, "available": 0.0} for b in ("needs", "wants", "savings")}
    budgeted_cat_ids: set[int] = set()

    planned = _planned_lines(lines, history, year, mon, budget.start_month)
    for ln, amount in planned:
        cat = cats.get(ln.category_id)
        budgeted_cat_ids.add(ln.category_id)
        budgeted_cat_ids.update(children.get(ln.category_id, []))

        actual = _subtree_total(ln.category_id, cur_totals, children)
        prior_actual = _subtree_total(ln.category_id, prev_totals, children)

        carryover = 0.0
        if ln.rollover_enabled and elapsed_before > 0:
            # Each past month at the amount it had then, not today's.
            carryover = line_carryover(
                ln, history.get(ln.id, []), spend_by_month, children, budget.start_month, year, mon,
            )

        available = round(amount + carryover, 2)
        remaining = round(available - actual, 2)
        pct = round(actual / available, 4) if available > 0 else (1.0 if actual > 0 else 0.0)

        if is_current and day_of_month > 0:
            projected = round(actual / day_of_month * days_in_month, 2)
        else:
            projected = round(actual, 2)

        bucket = ln.bucket if ln.bucket in buckets else "wants"
        buckets[bucket]["budgeted"] += amount
        buckets[bucket]["actual"] += actual
        buckets[bucket]["available"] += available

        line_rows.append({
            "category_id": ln.category_id,
            "name": cat.name if cat else "—",
            "color": cat.color if cat else None,
            "icon": cat.icon if cat else None,
            "bucket": bucket,
            "position": ln.position,
            "rollover_enabled": bool(ln.rollover_enabled),
            # This month's amount is a one-month change, not the line's usual one.
            "one_month": any(
                r.scope == "month" and r.month == m_from for r in history.get(ln.id, [])
            ),
            "budgeted": round(amount, 2),
            "carryover": carryover,
            "available": available,
            "actual": round(actual, 2),
            "remaining": remaining,
            "pct": pct,
            "projected": projected,
            "prior_actual": round(prior_actual, 2),
        })

    # The user's order inside each bucket; lines never moved fall back to the
    # largest amount first.
    line_rows.sort(key=lambda r: (r["position"], -r["budgeted"]))

    # Categories the user can add to this budget: the ones hidden from it, then
    # every other budgetable category without a line. A hidden one comes back
    # with its last amount.
    shown = {r["category_id"] for r in line_rows}
    by_category = {ln.category_id: ln for ln in lines}
    addable: list[dict] = []
    for c in cats.values():
        if c.id in shown or c.parent_id is None or c.name == "Uncategorized":
            continue
        if c.treatment not in ("expense", "transfer") or not is_budgetable(c.name, c.treatment):
            continue
        ln = by_category.get(c.id)
        last = 0.0
        if ln is not None:
            nonzero = [r for r in history.get(ln.id, []) if r.scope == "onward" and float(r.amount) > 0]
            last = float(nonzero[-1].amount) if nonzero else 0.0
        addable.append({
            "category_id": c.id,
            "name": c.name,
            "icon": c.icon,
            "hidden": ln is not None,
            "last_amount": round(last, 2),
            "bucket": ln.bucket if ln is not None else default_bucket_for(c.name, c.treatment),
            # Spent this month, so a row added back shows its Used figure
            # before the change is saved.
            "actual": round(_subtree_total(c.id, cur_totals, children), 2),
        })
    addable.sort(key=lambda a: (not a["hidden"], a["name"].lower()))

    for b in buckets.values():
        b["budgeted"] = round(b["budgeted"], 2)
        b["actual"] = round(b["actual"], 2)
        b["available"] = round(b["available"], 2)
        b["remaining"] = round(b["available"] - b["actual"], 2)

    allocated = sum(amount for _ln, amount in planned)
    total_budget = float(budget.total_target) if budget.total_target is not None else allocated
    total_spent = round(sum(r["actual"] for r in line_rows), 2)
    safe_to_spend = round(total_budget - total_spent, 2)

    # ── Unbudgeted spend: expense outflow in categories with no budget line ───
    # Each category clipped at zero first: a refund in one category is no
    # spending there, and must not cancel spending in another.
    unbudgeted = 0.0
    for cid, amt in cur_totals.items():
        if cid in budgeted_cat_ids:
            continue
        c = cats.get(cid)
        if c is not None and c.treatment == "expense":
            unbudgeted += max(amt, 0.0)
    unbudgeted = round(max(unbudgeted, 0.0), 2)

    return {
        "enrolled": True,
        "month": f"{year:04d}-{mon:02d}",
        "is_current": is_current,
        # The month is earlier than the budget: nothing was planned for it, so
        # its numbers are shown for reference and not graded.
        "before_start": (year, mon) < (budget.start_month.year, budget.start_month.month),
        "total_budget": round(total_budget, 2),
        "allocated": round(allocated, 2),
        "total_spent": total_spent,
        "safe_to_spend": safe_to_spend,
        "unbudgeted_spend": unbudgeted,
        "days_in_month": days_in_month,
        "days_remaining": days_remaining,
        "month_pct_elapsed": month_pct_elapsed,
        "buckets": buckets,
        "lines": line_rows,
        "addable": addable,
    }


async def category_detail(
    db: AsyncSession,
    user_id: int,
    category_id: int,
    month: Optional[str] = None,
    months: int = 6,
) -> dict:
    """What the Budget tab's pop-ups show for one category.

    The spending of the `months` whole months before `month`, last month's
    figure and their average (the Allocated pop-up), and the transactions that
    make up this month's Used figure (the Used pop-up). Counted the way
    ``_category_spend_totals`` counts a line's actual: refunds net out of an
    expense category, and a transfer-tree category counts only money leaving.
    """
    cats = await _user_categories(db, user_id)
    cat = cats.get(category_id)
    if cat is None:
        return {}
    children = _children_of(cats)
    acct_ids = await _get_account_ids(db, user_id)
    year, mon = parse_month(month)

    history = []
    for delta in range(-months, 0):
        y, m = add_months(year, mon, delta)
        f, t = month_bounds(y, m)
        totals = await _category_spend_totals(db, acct_ids, f, t)
        history.append({
            "month": f"{y:04d}-{m:02d}",
            "label": date(y, m, 1).strftime("%b"),
            "spent": round(_subtree_total(category_id, totals, children), 2),
        })

    m_from, m_to = month_bounds(year, mon)
    ids = [category_id, *children.get(category_id, [])]
    rows = []
    if acct_ids:
        q = (
            select(Transaction)
            .where(
                Transaction.account_id.in_(acct_ids),
                Transaction.category_id.in_(ids),
                Transaction.date_posted >= m_from,
                Transaction.date_posted <= m_to,
                _NOT_PENDING,
                _NOT_LOAN_CREDIT,
            )
            .order_by(Transaction.date_posted.desc(), Transaction.id.desc())
        )
        if cat.treatment == "transfer":
            q = q.where(Transaction.amount < 0)
        rows = (await db.scalars(q)).all()

    spent = [h["spent"] for h in history]
    return {
        "category_id": category_id,
        "name": cat.name,
        "month": f"{year:04d}-{mon:02d}",
        "history": history,
        "last_month": spent[-1] if spent else 0.0,
        "average": round(sum(spent) / len(spent), 2) if spent else 0.0,
        "transactions": [
            {
                "id": tx.id,
                "date": tx.date_posted.isoformat(),
                "description": tx.merchant_name or tx.description or "",
                # Spending as a positive number, a refund as a negative one.
                "amount": round(-float(tx.amount), 2),
            }
            for tx in rows
        ],
    }


async def _category_daily_spend(
    db: AsyncSession,
    acct_ids: list[int],
    category_ids: list[int],
    date_from: date,
    date_to: date,
) -> dict[date, float]:
    """date → money spent in these categories that day, counted the way
    ``_category_spend_totals`` counts a month (refunds net out of an expense
    category; a transfer-tree category counts only money leaving)."""
    if not acct_ids:
        return {}
    spent = case(
        (Category.treatment == "transfer",
         case((Transaction.amount < 0, -Transaction.amount), else_=0)),
        else_=-Transaction.amount,
    )
    rows = (await db.execute(
        select(Transaction.date_posted, func.sum(spent).label("total"))
        .join(Category, Category.id == Transaction.category_id)
        .where(
            Transaction.account_id.in_(acct_ids),
            Transaction.category_id.in_(category_ids),
            Transaction.date_posted >= date_from,
            Transaction.date_posted <= date_to,
            _NOT_PENDING,
            _NOT_LOAN_CREDIT,
        )
        .group_by(Transaction.date_posted)
    )).all()
    return {r.date_posted: float(r.total or 0) for r in rows}


async def category_report(
    db: AsyncSession,
    user_id: int,
    category_id: int,
    date_from: date,
    date_to: date,
) -> dict:
    """One category over a range of months, for its side drawer.

    Per month: what the active budget allocated to it (None before the budget
    started, or with no line), what was used, and, with rollover on, what was
    carried in and out. Carry accrues from the budget's start month, the way
    ``get_progress`` computes it, even when the range starts later. Also the
    line's amount history, so the drawer can say which months used which amount.
    """
    cats = await _user_categories(db, user_id)
    if category_id not in cats:
        return {}
    children = _children_of(cats)
    acct_ids = await _get_account_ids(db, user_id)
    budget = await active_budget(db, user_id)
    line = None
    if budget is not None:
        line = await db.scalar(
            select(BudgetLine).where(BudgetLine.budget_id == budget.id, BudgetLine.category_id == category_id)
        )
    history = (await load_amount_history(db, [line])).get(line.id, []) if line is not None else []
    start = budget.start_month if budget is not None else None
    rollover = bool(line is not None and line.rollover_enabled)

    first = (date_from.year, date_from.month)
    last = (date_to.year, date_to.month)
    y, m = first
    if start is not None and line is not None and (start.year, start.month) < first:
        y, m = start.year, start.month
    months: list[dict] = []
    carried = 0.0
    while (y, m) <= last and len(months) < 120:
        f, t = month_bounds(y, m)
        totals = await _category_spend_totals(db, acct_ids, f, t)
        spent = round(_subtree_total(category_id, totals, children), 2)
        graded = line is not None and start is not None and f >= start
        # None before the line was added or after it was removed: those
        # months carry nothing, as in get_progress.
        allocated = planned_amount(line, history, y, m, start) if graded else None
        graded = graded and allocated is not None
        row = {
            "month": f"{y:04d}-{m:02d}",
            "label": f.strftime("%b %Y"),
            "allocated": None if allocated is None else round(allocated, 2),
            "spent": spent,
            "carried_in": None,
            "carried_out": None,
        }
        if graded and rollover and f >= rollover_origin(line, start):
            row["carried_in"] = round(carried, 2)
            carried = carried + allocated - spent
            row["carried_out"] = round(carried, 2)
        if (y, m) >= first:
            months.append(row)
        y, m = add_months(y, m, 1)

    # Under three calendar months, monthly figures are one or two bars. The
    # drawer then shows weekly bars and a day-by-day running total instead.
    granularity = "month"
    weeks: list[dict] = []
    days: list[dict] = []
    if months_between(date_from, *last) + 1 < 3:
        granularity = "week"
        daily = await _category_daily_spend(
            db, acct_ids, [category_id, *children.get(category_id, [])], date_from, date_to,
        )
        allocated_by_month = {r["month"]: r["allocated"] for r in months}
        cumulative = 0.0
        budget_so_far = 0.0
        d = date_from
        while d <= date_to:
            key = f"{d.year:04d}-{d.month:02d}"
            month_amount = allocated_by_month.get(key)
            # The month's allocation is available from its first day in the range.
            if month_amount is not None and (d.day == 1 or d == date_from):
                budget_so_far += month_amount
            spent_today = daily.get(d, 0.0)
            cumulative += spent_today
            days.append({
                "date": d.isoformat(),
                "spent": round(spent_today, 2),
                "cumulative": round(cumulative, 2),
                "allocated": round(budget_so_far, 2) if line is not None else None,
            })
            # Weeks start on Monday and are cut to the range. Sums are kept
            # unrounded and rounded once, so a month's weeks add up to it.
            if not weeks or d.weekday() == 0:
                weeks.append({"start": d.isoformat(), "label": d.strftime("%b %-d"),
                              "_spent": 0.0, "_allocated": 0.0 if line is not None else None})
            weeks[-1]["_spent"] += spent_today
            if month_amount is not None and weeks[-1]["_allocated"] is not None:
                # A month's allocation spread evenly over its days.
                weeks[-1]["_allocated"] += month_amount / monthrange(d.year, d.month)[1]
            d = date.fromordinal(d.toordinal() + 1)
        weeks = [
            {
                "start": w["start"],
                "label": w["label"],
                "spent": round(w["_spent"], 2),
                "allocated": None if w["_allocated"] is None else round(w["_allocated"], 2),
            }
            for w in weeks
        ]

    return {
        "category_id": category_id,
        "name": cats[category_id].name,
        "granularity": granularity,
        "weeks": weeks,
        "days": days,
        "on_budget": line is not None and not line.hidden,
        "rollover_enabled": rollover,
        "amounts": [
            {"month": f"{r.month.year:04d}-{r.month.month:02d}", "amount": round(float(r.amount), 2), "scope": r.scope}
            for r in history
        ],
        "months": months,
    }


def status_for(total_budget: float, total_spent: float) -> str:
    """Traffic-light grade for a month's total spend against its total budget.

    excelled — on or under budget; struggled — modestly over (≤15%);
    failed — well over (>15%); none — no budgeted spend recorded (treated as
    "no activity" rather than a false green). ``get_history`` adds a fifth,
    ``no_budget``, for months before the budget existed.
    """
    if total_budget <= 0 or total_spent <= 0:
        return "none"
    ratio = total_spent / total_budget
    if ratio <= 1.0:
        return "excelled"
    if ratio <= 1.15:
        return "struggled"
    return "failed"


async def get_history(db: AsyncSession, user_id: int, months: int = 12) -> dict:
    """Per-month budget adherence for the trailing `months`, ending this month.

    Each month is graded against the budget's total, or, without one, against
    what its lines planned for that month. A month before the budget started
    was never planned, so it is ``no_budget`` and ``before_start``, with its
    spending against the first amounts for comparison only, as ``get_progress``
    shows it. Months without budgeted spend grade as "none" (neutral), not a
    false pass.
    """
    budget = await active_budget(db, user_id)
    if budget is None:
        return {"enrolled": False, "months": []}

    lines = (await db.scalars(
        select(BudgetLine).where(BudgetLine.budget_id == budget.id)
    )).all()
    acct_ids = await _get_account_ids(db, user_id)
    cats = await _user_categories(db, user_id)
    children = _children_of(cats)
    lines = _budgetable_lines(lines, cats)
    history = await load_amount_history(db, lines)

    today = local_today()
    out: list[dict] = []
    for delta in range(-(months - 1), 1):
        y, m = add_months(today.year, today.month, delta)
        m_from, m_to = month_bounds(y, m)
        planned = _planned_lines(lines, history, y, m, budget.start_month)
        allocated = sum(amount for _ln, amount in planned)
        total_budget = float(budget.total_target) if budget.total_target is not None else allocated
        totals = await _category_spend_totals(db, acct_ids, m_from, m_to)
        spent = round(sum(_subtree_total(ln.category_id, totals, children) for ln, _amount in planned), 2)
        before_start = (y, m) < (budget.start_month.year, budget.start_month.month)
        out.append({
            "month": f"{y:04d}-{m:02d}",
            "label": date(y, m, 1).strftime("%b"),
            "year": y,
            "total_budget": round(total_budget, 2),
            "total_spent": spent,
            "ratio": None if before_start else (round(spent / total_budget, 4) if total_budget > 0 else None),
            # Never graded before the budget started. Its spending is
            # still given, so the strip can show it for comparison the way
            # the month itself does.
            "status": "no_budget" if before_start else status_for(total_budget, spent),
            "is_current": (y, m) == (today.year, today.month),
            "before_start": before_start,
        })

    return {"enrolled": True, "months": out}


def trailing_window(trailing_months: int = 3, today: date | None = None) -> tuple[date, date]:
    """The last `trailing_months` whole months, ending with last month.

    A monthly average needs whole months; the screens that show it name the
    months, since "last 3 months" elsewhere includes this month so far.
    """
    today = today or local_today()
    ty, tm = add_months(today.year, today.month, -trailing_months)
    py, pm = add_months(today.year, today.month, -1)
    return date(ty, tm, 1), month_bounds(py, pm)[1]


async def suggested_income(db: AsyncSession, user_id: int, trailing_months: int = 3) -> float:
    """Trailing-average monthly income over the last `trailing_months` whole months."""
    start, end = trailing_window(trailing_months)
    data = await get_income(db, user_id, start, end)
    cats = await _user_categories(db, user_id)
    # Money in under an expense category is a refund, not income: a returned
    # $500 flight made "my average income" $500.
    # Uncategorized money in (no category) still counts, as before.
    total = sum(
        float(r["total"] or 0)
        for r in data.get("by_category") or []
        if r.get("category_id") not in cats or cats[r["category_id"]].treatment == "income"
    )
    return round(total / max(trailing_months, 1), 2)

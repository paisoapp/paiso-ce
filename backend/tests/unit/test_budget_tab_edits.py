"""Unit tests for the Budget tab's inline edits: an amount for this
month only or from this month on, removing and adding categories, reordering,
and the per-category detail behind the pop-ups. Calls the route handlers
directly against an in-memory SQLite DB, like test_budget_amounts_by_month.
"""
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as api
from app.core.database import Base
from app.models.account import Account
from app.models.budget import Budget, BudgetLine, BudgetLineAmount
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.plan import add_months, get_progress

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
    await engine.dispose()


def _month(delta: int) -> date:
    today = date.today()
    y, m = add_months(today.year, today.month, delta)
    return date(y, m, 1)


def _key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


async def _setup(db: AsyncSession):
    """Groceries $500 and Dining $200, enrolled two months ago; Gas has no line.
    Groceries spending: $300 in each of the last two months, $80 this month
    plus a $20 refund."""
    user = User(email="tab@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    acct = Account(user_id=user.id, account_type="checking", display_name="Chk")
    parent = Category(user_id=user.id, name="Expense", treatment="expense")
    db.add_all([acct, parent])
    await db.flush()
    groceries = Category(user_id=user.id, name="Groceries", treatment="expense", parent_id=parent.id)
    dining = Category(user_id=user.id, name="Restaurants", treatment="expense", parent_id=parent.id)
    gas = Category(user_id=user.id, name="Gas", treatment="expense", parent_id=parent.id)
    db.add_all([groceries, dining, gas])
    await db.flush()
    today = date.today()
    for i in (1, 2):
        db.add(Transaction(account_id=acct.id, date_posted=_month(-i).replace(day=10), amount=-300,
                           description="g", category_id=groceries.id))
    this = date(today.year, today.month, 1)
    db.add_all([
        Transaction(account_id=acct.id, date_posted=this, amount=-80, description="Market",
                    category_id=groceries.id),
        Transaction(account_id=acct.id, date_posted=this, amount=20, description="Refund",
                    category_id=groceries.id),
    ])
    await db.commit()
    await api.create_plan(api.BudgetPlanIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)
    budget = await db.scalar(select(Budget).where(Budget.user_id == user.id))
    budget.start_month = _month(-2)
    for row in (await db.scalars(select(BudgetLineAmount))).all():
        row.month = budget.start_month
    await db.commit()
    return user, groceries, dining, gas


def _lines(progress: dict) -> dict:
    return {ln["name"]: ln for ln in progress["lines"]}


async def test_this_month_only_leaves_next_month_alone(db):
    user, groceries, _dining, _gas = await _setup(db)
    p = await api.edit_line(groceries.id, api.BudgetLineEdit(amount=650, scope="month"), db=db, user=user)
    assert _lines(p)["Groceries"]["budgeted"] == 650.0
    assert _lines(p)["Groceries"]["one_month"] is True
    nxt = _lines(await get_progress(db, user.id, _key(_month(1))))
    assert nxt["Groceries"]["budgeted"] == 500.0

    # "This month and later" replaces the one-month change.
    p = await api.edit_line(groceries.id, api.BudgetLineEdit(amount=550), db=db, user=user)
    assert _lines(p)["Groceries"]["budgeted"] == 550.0
    assert _lines(p)["Groceries"]["one_month"] is False
    assert _lines(await get_progress(db, user.id, _key(_month(1))))["Groceries"]["budgeted"] == 550.0
    assert _lines(await get_progress(db, user.id, _key(_month(-1))))["Groceries"]["budgeted"] == 500.0


async def test_a_future_month_can_be_set_and_a_past_one_cannot(db):
    user, groceries, _dining, _gas = await _setup(db)
    await api.edit_line(groceries.id, api.BudgetLineEdit(amount=700, month=_key(_month(1))), db=db, user=user)
    assert _lines(await get_progress(db, user.id))["Groceries"]["budgeted"] == 500.0
    assert _lines(await get_progress(db, user.id, _key(_month(1))))["Groceries"]["budgeted"] == 700.0
    with pytest.raises(HTTPException) as exc:
        await api.edit_line(groceries.id, api.BudgetLineEdit(amount=1, month=_key(_month(-1))), db=db, user=user)
    assert exc.value.status_code == 422


async def test_remove_and_add_back_keeps_the_last_amount(db):
    user, _groceries, dining, _gas = await _setup(db)
    p = await api.edit_line(dining.id, api.BudgetLineEdit(hidden=True), db=db, user=user)
    assert "Restaurants" not in _lines(p)
    assert {a["name"]: a for a in p["addable"]}["Restaurants"] == {
        "category_id": dining.id, "name": "Restaurants", "icon": None, "hidden": True, "last_amount": 200.0, "bucket": "wants", "actual": 0.0,
    }
    p = await api.edit_line(dining.id, api.BudgetLineEdit(hidden=False), db=db, user=user)
    assert _lines(p)["Restaurants"]["budgeted"] == 200.0


async def test_a_new_category_can_be_added_and_plans_nothing_before(db):
    user, _groceries, _dining, gas = await _setup(db)
    p = await api.edit_line(gas.id, api.BudgetLineEdit(amount=90, bucket="needs"), db=db, user=user)
    assert _lines(p)["Gas"]["budgeted"] == 90.0
    assert "Gas" not in _lines(await get_progress(db, user.id, _key(_month(-1))))


async def test_a_zero_line_stays_on_the_budget(db):
    user, groceries, dining, _gas = await _setup(db)
    await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=0, bucket="wants"),
    ]), db=db, user=user)
    assert _lines(await get_progress(db, user.id))["Restaurants"]["budgeted"] == 0.0
    plan = await api.get_plan(db=db, user=user)
    assert dining.id in {ln["category_id"] for ln in plan["lines"]}


async def test_reorder_moves_lines_between_buckets(db):
    user, groceries, dining, _gas = await _setup(db)
    await api.reorder_lines([
        api.BudgetLineOrder(category_id=dining.id, bucket="needs", position=0),
        api.BudgetLineOrder(category_id=groceries.id, bucket="needs", position=1),
    ], db=db, user=user)
    lines = (await get_progress(db, user.id))["lines"]
    assert [(ln["name"], ln["bucket"]) for ln in lines] == [("Restaurants", "needs"), ("Groceries", "needs")]


async def test_category_detail_matches_the_used_figure(db):
    user, groceries, _dining, _gas = await _setup(db)
    detail = await api.plan_category_detail(groceries.id, month=None, db=db, user=user)
    assert [h["spent"] for h in detail["history"]][-2:] == [300.0, 300.0]
    assert detail["last_month"] == 300.0
    assert detail["average"] == 100.0  # $600 over six months
    assert sorted(t["amount"] for t in detail["transactions"]) == [-20.0, 80.0]
    used = _lines(await get_progress(db, user.id))["Groceries"]["actual"]
    assert used == round(sum(t["amount"] for t in detail["transactions"]), 2) == 60.0


async def test_moving_from_the_menu_goes_to_the_end_of_the_bucket(db):
    user, groceries, dining, _gas = await _setup(db)
    p = await api.edit_line(groceries.id, api.BudgetLineEdit(bucket="wants"), db=db, user=user)
    assert [(ln["name"], ln["bucket"]) for ln in p["lines"]] == [("Restaurants", "wants"), ("Groceries", "wants")]


async def test_category_report_carries_rollover_from_the_start(db):
    user, groceries, _dining, gas = await _setup(db)
    await api.edit_line(groceries.id, api.BudgetLineEdit(amount=650, scope="month"), db=db, user=user)
    this = _month(0)
    # Starting the range at last month still carries from the budget's start.
    report = await api.plan_category_report(groceries.id, date_from=_month(-1), date_to=this, db=db, user=user)
    assert report["rollover_enabled"] is True
    rows = {r["month"]: r for r in report["months"]}
    last = rows[_key(_month(-1))]
    assert (last["allocated"], last["spent"], last["carried_in"], last["carried_out"]) == (500.0, 300.0, 200.0, 400.0)
    now = rows[_key(this)]
    assert (now["allocated"], now["spent"], now["carried_in"]) == (650.0, 60.0, 400.0)
    assert [(a["month"], a["amount"], a["scope"]) for a in report["amounts"]] == [
        (_key(_month(-2)), 500.0, "onward"), (_key(this), 650.0, "month"),
    ]
    # A category with no line: spending only.
    gas_report = await api.plan_category_report(gas.id, date_from=_month(-1), date_to=this, db=db, user=user)
    assert gas_report["on_budget"] is False
    assert all(r["allocated"] is None and r["carried_in"] is None for r in gas_report["months"])


async def test_a_short_range_reports_weeks_and_a_running_total(db):
    user, groceries, _dining, _gas = await _setup(db)
    last = _month(-1)
    end = _month(0).replace(day=1)
    end = date.fromordinal(end.toordinal() - 1)  # last day of last month
    report = await api.plan_category_report(groceries.id, date_from=last, date_to=end, db=db, user=user)
    assert report["granularity"] == "week"
    assert report["weeks"][0]["start"] == last.isoformat()
    assert round(sum(w["spent"] for w in report["weeks"]), 2) == 300.0
    # Each week rounds on its own, so the sum can be off by a cent or two.
    assert abs(sum(w["allocated"] for w in report["weeks"]) - 500.0) < 0.05
    assert report["days"][-1]["cumulative"] == 300.0
    assert {d["allocated"] for d in report["days"]} == {500.0}
    # Three calendar months or more stay monthly.
    long = await api.plan_category_report(groceries.id, date_from=_month(-2), date_to=_month(0), db=db, user=user)
    assert long["granularity"] == "month" and long["weeks"] == [] and long["days"] == []


async def test_fill_from_averages_and_reset(db):
    user, groceries, dining, _gas = await _setup(db)
    await api.edit_line(dining.id, api.BudgetLineEdit(hidden=True), db=db, user=user)
    # The trailing average covers the last three whole months: $300 + $300 + $0.
    p = await api.set_all_amounts(api.BudgetAmountsAction(action="averages"), db=db, user=user)
    assert _lines(p)["Groceries"]["budgeted"] == 200.0
    assert "Restaurants" not in _lines(p)  # removed lines are left out of a fill
    assert _lines(await get_progress(db, user.id, _key(_month(-1))))["Groceries"]["budgeted"] == 500.0

    # Reset for this month only: every line at $0, removed ones back, next month untouched.
    p = await api.set_all_amounts(api.BudgetAmountsAction(action="reset", scope="month"), db=db, user=user)
    assert {n: ln["budgeted"] for n, ln in _lines(p).items()} == {"Groceries": 0.0, "Restaurants": 0.0}
    assert _lines(await get_progress(db, user.id, _key(_month(1))))["Groceries"]["budgeted"] == 200.0

    with pytest.raises(HTTPException) as exc:
        await api.set_all_amounts(api.BudgetAmountsAction(action="reset", month=_key(_month(-1))), db=db, user=user)
    assert exc.value.status_code == 422


async def test_rollover_counts_from_the_month_it_is_turned_on(db):
    """Restaurants spent nothing for two months at $200. Turned on now,
    it carries nothing in this month, not $400 of months it never tracked.
    Off and on again starts afresh; lines on from the start keep counting
    from the start."""
    user, groceries, dining, _gas = await _setup(db)
    await api.edit_line(dining.id, api.BudgetLineEdit(rollover_enabled=True), db=db, user=user)
    line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == dining.id))
    assert line.rollover_from == _month(0)
    lines = _lines(await get_progress(db, user.id, _key(_month(0))))
    assert lines["Restaurants"]["rollover_enabled"] is True
    assert lines["Restaurants"]["carryover"] == 0
    assert lines["Groceries"]["carryover"] == 400  # on since the start: $200 + $200
    report = await api.plan_category_report(dining.id, date_from=_month(-2), date_to=_month(0), db=db, user=user)
    assert [r["carried_in"] for r in report["months"]] == [None, None, 0.0]

    await api.edit_line(groceries.id, api.BudgetLineEdit(rollover_enabled=False), db=db, user=user)
    await api.edit_line(groceries.id, api.BudgetLineEdit(rollover_enabled=True), db=db, user=user)
    assert _lines(await get_progress(db, user.id, _key(_month(0))))["Groceries"]["carryover"] == 0


async def test_budget_wide_rollover_switch(db):
    """the settings switch turns every category on from this month, and
    a category added afterwards starts with rollover on."""
    user, _groceries, dining, gas = await _setup(db)
    plan = await api.update_plan(api.BudgetConfigIn(rollover_default=True), db=db, user=user)
    assert plan["rollover_default"] is True
    assert all(ln["rollover_enabled"] for ln in plan["lines"])
    dining_line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == dining.id))
    assert dining_line.rollover_from == _month(0)
    await api.edit_line(gas.id, api.BudgetLineEdit(amount=60), db=db, user=user)
    gas_line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == gas.id))
    assert gas_line.rollover_enabled == 1
    plan = await api.update_plan(api.BudgetConfigIn(rollover_default=False), db=db, user=user)
    assert not any(ln["rollover_enabled"] for ln in plan["lines"])

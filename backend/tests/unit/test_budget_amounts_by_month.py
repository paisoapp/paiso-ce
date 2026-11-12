"""Unit tests for budget amounts stored by month.

A line's amount used to be one number for every month, so changing it changed
every past month and the rollover they carried. Each change is now a
``BudgetLineAmount`` row from a month on. Calls the route handlers directly
against an in-memory SQLite DB, like test_budget_profiles.
"""
from datetime import date

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as api
from app.core.database import Base
from app.models.account import Account
from app.models.budget import Budget, BudgetLine, BudgetLineAmount
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.plan import add_months, amount_for, get_history, get_progress

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


async def _setup(db: AsyncSession, months_ago: int = 3):
    """A user with Groceries ($500, rollover on) and Dining ($200), enrolled
    `months_ago` months back, who spent $400 on groceries in each past month."""
    user = User(email="months@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    acct = Account(user_id=user.id, account_type="checking", display_name="Chk")
    groceries = Category(user_id=user.id, name="Groceries", treatment="expense")
    dining = Category(user_id=user.id, name="Restaurants", treatment="expense")
    db.add_all([acct, groceries, dining])
    await db.flush()
    for i in range(1, months_ago + 1):
        db.add(Transaction(account_id=acct.id, date_posted=_month(-i).replace(day=15), amount=-400,
                           description="g", category_id=groceries.id))
    await db.commit()

    await api.create_plan(api.BudgetPlanIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)
    # Move the budget, and the amounts saved with it, back to `months_ago`.
    budget = await db.scalar(select(Budget).where(Budget.user_id == user.id))
    budget.start_month = _month(-months_ago)
    for row in (await db.scalars(select(BudgetLineAmount))).all():
        row.month = budget.start_month
    await db.commit()
    return user, groceries, dining


async def test_raising_an_amount_leaves_past_months_and_their_rollover_alone(db):
    user, groceries, dining = await _setup(db)
    before = {ln["name"]: ln for ln in (await get_progress(db, user.id))["lines"]}
    # Three months at $500 with $400 spent each: +$300 carried in.
    assert before["Groceries"]["carryover"] == 300.0

    await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=650, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)

    now = {ln["name"]: ln for ln in (await get_progress(db, user.id))["lines"]}
    assert now["Groceries"]["budgeted"] == 650.0
    # Still +$300: the old code multiplied $650 by three months and carried +$750.
    assert now["Groceries"]["carryover"] == 300.0
    last_month = {ln["name"]: ln for ln in (await get_progress(db, user.id, _key(_month(-1))))["lines"]}
    assert last_month["Groceries"]["budgeted"] == 500.0


async def test_an_unchanged_save_writes_no_new_amount(db):
    user, groceries, dining = await _setup(db)
    await api.update_plan(api.BudgetConfigIn(name="Same amounts", lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="wants", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)
    rows = (await db.scalars(select(BudgetLineAmount))).all()
    assert len(rows) == 2
    plan = await api.get_plan(db=db, user=user)
    assert {ln["category_id"]: ln["bucket"] for ln in plan["lines"]}[groceries.id] == "wants"


async def test_a_category_left_out_is_hidden_not_deleted(db):
    user, groceries, dining = await _setup(db)
    plan = await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
    ]), db=db, user=user)
    assert [ln["category_id"] for ln in plan["lines"]] == [groceries.id]

    line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == dining.id))
    assert line is not None and line.hidden is True and float(line.amount) == 0.0
    # Gone from this month, still in the months that planned for it.
    assert "Restaurants" not in {ln["name"] for ln in (await get_progress(db, user.id))["lines"]}
    last_month = {ln["name"]: ln for ln in (await get_progress(db, user.id, _key(_month(-1))))["lines"]}
    assert last_month["Restaurants"]["budgeted"] == 200.0

    # Added back, it is shown again with the new amount from this month.
    plan = await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=150, bucket="wants"),
    ]), db=db, user=user)
    assert {ln["category_id"]: ln["amount"] for ln in plan["lines"]}[dining.id] == 150.0
    assert {ln["name"]: ln["budgeted"] for ln in (await get_progress(db, user.id))["lines"]}["Restaurants"] == 150.0


async def test_history_grades_each_month_against_its_own_amounts(db):
    user, groceries, dining = await _setup(db)
    await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=900, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)
    months = {m["month"]: m for m in (await get_history(db, user.id))["months"]}
    assert months[_key(_month(-1))]["total_budget"] == 700.0
    assert months[_key(_month(0))]["total_budget"] == 1100.0


async def test_amount_for_rules():
    start = date(2026, 3, 1)
    line = BudgetLine(amount=999)
    history = [
        BudgetLineAmount(month=date(2026, 3, 1), amount=500, scope="onward"),
        BudgetLineAmount(month=date(2026, 6, 1), amount=650, scope="onward"),
        BudgetLineAmount(month=date(2026, 7, 1), amount=100, scope="month"),
    ]
    assert amount_for(line, history, 2026, 4, start) == 500.0
    assert amount_for(line, history, 2026, 6, start) == 650.0
    # A one-month amount wins for that month only.
    assert amount_for(line, history, 2026, 7, start) == 100.0
    assert amount_for(line, history, 2026, 8, start) == 650.0
    # Before the budget started: compared against the first amount.
    assert amount_for(line, history, 2026, 1, start) == 500.0
    # A line added later plans nothing before it was added.
    added_later = [BudgetLineAmount(month=date(2026, 6, 1), amount=80, scope="onward")]
    assert amount_for(line, added_later, 2026, 4, start) == 0.0
    # No rows (an older line): its one amount, every month.
    assert amount_for(line, [], 2026, 4, start) == 999.0


async def test_a_line_saved_before_amounts_were_stored_keeps_its_past(db):
    user, groceries, dining = await _setup(db)
    # Drop the history, as for an older line with no migration row.
    for row in (await db.scalars(select(BudgetLineAmount))).all():
        await db.delete(row)
    await db.commit()

    await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=650, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
    ]), db=db, user=user)
    now = {ln["name"]: ln for ln in (await get_progress(db, user.id))["lines"]}
    assert now["Groceries"]["budgeted"] == 650.0
    assert now["Groceries"]["carryover"] == 300.0


async def test_a_category_added_later_plans_nothing_before_it_was_added(db):
    user, groceries, dining = await _setup(db)
    fuel = Category(user_id=user.id, name="Gas", treatment="expense")
    db.add(fuel)
    await db.commit()
    await api.update_plan(api.BudgetConfigIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=dining.id, amount=200, bucket="wants"),
        api.BudgetLineIn(category_id=fuel.id, amount=120, bucket="needs", rollover_enabled=True),
    ]), db=db, user=user)
    now = {ln["name"]: ln for ln in (await get_progress(db, user.id))["lines"]}
    assert now["Gas"]["budgeted"] == 120.0
    assert now["Gas"]["carryover"] == 0.0
    last_month = {ln["name"] for ln in (await get_progress(db, user.id, _key(_month(-1))))["lines"]}
    assert "Gas" not in last_month

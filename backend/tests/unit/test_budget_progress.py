"""Unit tests for budget-plan progress math — pacing, rollover, prior-month overlay.

Runs fully in-process against an in-memory SQLite DB (no server). Builds a minimal
fixture: one user, one account, a couple of categories, a Budget + BudgetLines, and
transactions across the current and prior months, then asserts the computed payload.
"""
from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.account import Account
from app.models.budget import Budget, BudgetLine
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.plan import add_months, get_progress, status_for

pytestmark = pytest.mark.unit


def _first_of_month(d: date) -> date:
    return date(d.year, d.month, 1)


async def _setup(db: AsyncSession):
    user = User(email="bud@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()

    acct = Account(user_id=user.id, account_type="checking", display_name="Chk")
    db.add(acct)
    await db.flush()

    groceries = Category(user_id=user.id, name="Groceries", treatment="expense", color="#1")
    dining = Category(user_id=user.id, name="Restaurants", treatment="expense", color="#2")
    db.add_all([groceries, dining])
    await db.flush()

    today = date.today()
    py, pm = add_months(today.year, today.month, -1)
    # Enrolled one month ago so the current month has one prior month of accrual.
    budget = Budget(user_id=user.id, total_target=1000, income_basis="manual",
                    start_month=date(py, pm, 1))
    db.add(budget)
    await db.flush()

    db.add_all([
        BudgetLine(user_id=user.id, budget_id=budget.id, category_id=groceries.id,
                   amount=400, bucket="needs", rollover_enabled=1),
        BudgetLine(user_id=user.id, budget_id=budget.id, category_id=dining.id,
                   amount=200, bucket="wants", rollover_enabled=0),
    ])

    # Current-month spend: groceries -100, dining -50 (amounts are negative = outflow).
    cur = date(today.year, today.month, min(today.day, 28))
    # Prior-month spend: groceries -300 (under its 400 budget → +100 rollover carry-in).
    prior = date(py, pm, 15)
    db.add_all([
        Transaction(account_id=acct.id, date_posted=cur, amount=-100, description="g1",
                    category_id=groceries.id),
        Transaction(account_id=acct.id, date_posted=cur, amount=-50, description="d1",
                    category_id=dining.id),
        Transaction(account_id=acct.id, date_posted=prior, amount=-300, description="g0",
                    category_id=groceries.id),
    ])
    await db.commit()
    return user.id


def test_status_for_thresholds():
    # No budget or no spend → neutral.
    assert status_for(0, 100) == "none"
    assert status_for(1000, 0) == "none"
    # On/under budget → excelled; ≤15% over → struggled; beyond → failed.
    assert status_for(1000, 800) == "excelled"
    assert status_for(1000, 1000) == "excelled"
    assert status_for(1000, 1150) == "struggled"
    assert status_for(1000, 1151) == "failed"
    assert status_for(1000, 5000) == "failed"


async def test_progress_pacing_rollover_prior():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            uid = await _setup(db)
            today = date.today()
            month = f"{today.year:04d}-{today.month:02d}"
            data = await get_progress(db, uid, month)

            assert data["enrolled"] is True
            assert data["is_current"] is True
            assert data["total_budget"] == 1000.0
            assert data["total_spent"] == 150.0  # 100 + 50
            assert data["safe_to_spend"] == 850.0

            lines = {l["name"]: l for l in data["lines"]}

            groc = lines["Groceries"]
            assert groc["actual"] == 100.0
            assert groc["prior_actual"] == 300.0  # overlay from last month
            # Rollover: prior month budgeted 400 − spent 300 = +100 carry-in.
            assert groc["carryover"] == 100.0
            assert groc["available"] == 500.0  # 400 + 100
            assert groc["remaining"] == 400.0  # 500 − 100

            dine = lines["Restaurants"]
            assert dine["actual"] == 50.0
            assert dine["carryover"] == 0.0  # rollover disabled
            assert dine["available"] == 200.0

            # Pacing: projected scales current spend to a full month → ≥ actual.
            assert groc["projected"] >= groc["actual"]

            # Bucket rollups.
            assert data["buckets"]["needs"]["actual"] == 100.0
            assert data["buckets"]["wants"]["actual"] == 50.0
    finally:
        await engine.dispose()

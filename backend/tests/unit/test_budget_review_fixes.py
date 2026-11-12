"""Unit tests for the fixes from the Budget tab review.

Each test names the issue number from that report. Calls the route handlers
directly against an in-memory SQLite DB, like test_budget_tab_edits.
"""
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as api
from app.api import categories as cat_api
from app.core import clock
from app.core.database import Base
from app.models.account import Account
from app.models.budget import Budget, BudgetLine, BudgetLineAmount
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.plan import add_months, category_report, get_progress, suggested_income

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


def _lines(progress: dict) -> dict:
    return {ln["name"]: ln for ln in progress["lines"]}


async def _setup(db: AsyncSession, start_delta: int = 0):
    """Groceries $500 (rollover on) and Personal Care $78, on a budget that
    starts `start_delta` months from now. Income and Expense are groups."""
    user = User(email="review@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    acct = Account(user_id=user.id, account_type="checking", display_name="Chk")
    expense = Category(user_id=user.id, name="Expense", treatment="expense", is_group=True)
    income = Category(user_id=user.id, name="Income", treatment="income", is_income=True, is_group=True)
    db.add_all([acct, expense, income])
    await db.flush()
    groceries = Category(user_id=user.id, name="Groceries", treatment="expense", parent_id=expense.id)
    care = Category(user_id=user.id, name="Personal Care", treatment="expense", parent_id=expense.id)
    travel = Category(user_id=user.id, name="Travel", treatment="expense", parent_id=expense.id)
    pay = Category(user_id=user.id, name="Paychecks", treatment="income", is_income=True, parent_id=income.id)
    db.add_all([groceries, care, travel, pay])
    await db.commit()
    await api.create_plan(api.BudgetPlanIn(lines=[
        api.BudgetLineIn(category_id=groceries.id, amount=500, bucket="needs", rollover_enabled=True),
        api.BudgetLineIn(category_id=care.id, amount=78, bucket="wants"),
    ]), db=db, user=user)
    if start_delta:
        budget = await db.scalar(select(Budget).where(Budget.user_id == user.id))
        budget.start_month = _month(start_delta)
        for row in (await db.scalars(select(BudgetLineAmount))).all():
            row.month = budget.start_month
        await db.commit()
    return user, acct, {"expense": expense, "income": income, "groceries": groceries,
                        "care": care, "travel": travel, "pay": pay}


def _spend(acct, category, when: date, amount: float, name: str = "x"):
    return Transaction(account_id=acct.id, date_posted=when, amount=amount, description=name,
                       category_id=category.id)


# ── Issue 1: removing in the budget's first month keeps the amount ──────────

async def test_remove_and_add_back_in_the_first_month_keeps_the_amount(db):
    user, _acct, c = await _setup(db)  # starts this month
    p = await api.edit_line(c["care"].id, api.BudgetLineEdit(hidden=True), db=db, user=user)
    assert "Personal Care" not in _lines(p)
    assert {a["name"]: a for a in p["addable"]}["Personal Care"]["last_amount"] == 78.0
    assert "Personal Care" not in _lines(await get_progress(db, user.id, _key(_month(1))))

    p = await api.edit_line(c["care"].id, api.BudgetLineEdit(hidden=False), db=db, user=user)
    assert _lines(p)["Personal Care"]["budgeted"] == 78.0
    assert _lines(p)["Personal Care"]["one_month"] is False
    assert _lines(await get_progress(db, user.id, _key(_month(1))))["Personal Care"]["budgeted"] == 78.0


async def test_a_category_moved_out_and_back_keeps_its_amount(db):
    user, _acct, c = await _setup(db)
    await cat_api.move_category(c["care"].id, cat_api.CategoryMove(group_id=c["income"].id, mode="keep"),
                                db=db, user=user)
    await cat_api.move_category(c["care"].id, cat_api.CategoryMove(group_id=c["expense"].id, mode="keep"),
                                db=db, user=user)
    p = await get_progress(db, user.id)
    assert {a["name"]: a for a in p["addable"]}["Personal Care"]["last_amount"] == 78.0


# ── Issue 4: moving into an income group keeps the months before ────────────

async def test_moving_into_income_keeps_the_months_before(db):
    user, acct, c = await _setup(db, start_delta=-2)
    db.add(_spend(acct, c["care"], _month(-1).replace(day=9), -78.5))
    await db.commit()
    await cat_api.move_category(c["care"].id, cat_api.CategoryMove(group_id=c["income"].id, mode="keep"),
                                db=db, user=user)
    assert "Personal Care" not in _lines(await get_progress(db, user.id))
    last = _lines(await get_progress(db, user.id, _key(_month(-1))))
    assert last["Personal Care"]["budgeted"] == 78.0


# ── Issue 5: unbudgeted spending is not cancelled by a refund elsewhere ─────

async def test_a_refund_in_one_category_does_not_cancel_unbudgeted_spending(db):
    user, acct, c = await _setup(db)
    today = date.today()
    db.add_all([
        _spend(acct, c["care"], today.replace(day=1), -78.5),
        _spend(acct, c["travel"], today.replace(day=1), 500),  # a refunded flight
    ])
    await db.commit()
    p = await api.edit_line(c["care"].id, api.BudgetLineEdit(hidden=True), db=db, user=user)
    assert p["unbudgeted_spend"] == 78.5


# ── Rollover, both ways, only while a line is on the budget ─────────────────

async def test_rollover_carries_both_ways_month_by_month(db):
    user, acct, c = await _setup(db, start_delta=-3)
    # $500 a month: $450, $620 and $480 spent → +50 − 120 + 20 = −50.
    for delta, amount in ((-3, -450), (-2, -620), (-1, -480)):
        db.add(_spend(acct, c["groceries"], _month(delta).replace(day=5), amount))
    await db.commit()
    now = _lines(await get_progress(db, user.id))["Groceries"]
    assert now["carryover"] == -50.0
    assert now["available"] == 450.0
    # The next month carries this month's result on top.
    db.add(_spend(acct, c["groceries"], date.today().replace(day=1), -100))
    await db.commit()
    nxt = _lines(await get_progress(db, user.id, _key(_month(1))))["Groceries"]
    assert nxt["carryover"] == 350.0  # −50 carried in, + $500 − $100 this month
    # The drawer's table agrees with the tab.
    report = await category_report(db, user.id, c["groceries"].id, _month(-1), date.today())
    assert [m["carried_in"] for m in report["months"]] == [-70.0, -50.0]
    assert report["months"][-1]["carried_out"] == 350.0


async def test_rollover_ignores_months_before_a_line_was_added(db):
    user, acct, c = await _setup(db, start_delta=-3)
    for delta in (-3, -2, -1):
        db.add(_spend(acct, c["travel"], _month(delta).replace(day=5), -100))
    await db.commit()
    # Travel joins the budget last month at $120 with rollover on.
    await api.edit_line(c["travel"].id, api.BudgetLineEdit(amount=120, bucket="wants", rollover_enabled=True),
                        db=db, user=user)
    row = await db.scalar(select(BudgetLineAmount).join(BudgetLine).where(BudgetLine.category_id == c["travel"].id))
    row.month = _month(-1)
    # Rollover was turned on with it, last month.
    line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == c["travel"].id))
    line.rollover_from = _month(-1)
    await db.commit()
    # Only last month counts: $120 − $100. The old sum charged all $300.
    assert _lines(await get_progress(db, user.id))["Travel"]["carryover"] == 20.0


# ── Issue 6: the user's own date ────────────────────────────────────────────

def test_local_today_follows_the_browser_offset():
    utc_now = datetime.now(timezone.utc)
    token = clock.set_offset(clock.parse_offset("300"))  # Chicago in summer
    try:
        assert clock.local_today() == (utc_now - timedelta(minutes=300)).date()
    finally:
        clock._offset.reset(token)
    assert clock.parse_offset("not a number") is None
    assert clock.parse_offset("5000") is None
    assert clock.local_today() == date.today()


# ── Issue 8: a refund is not income ─────────────────────────────────────────

async def test_suggested_income_leaves_out_refunds(db):
    user, acct, c = await _setup(db)
    for delta in (-3, -2, -1):
        db.add(_spend(acct, c["pay"], _month(delta).replace(day=1), 3000))
    db.add(_spend(acct, c["travel"], _month(-1).replace(day=9), 500))
    await db.commit()
    assert await suggested_income(db, user.id, 3) == 3000.0


# ── Issues 2 and 7: card payments and bills charged to a card ───────────────

# ── Issue 21: twice a month is not every two weeks ──────────────────────────

# ── Issues 14 and 20: built-in groups, emoji ────────────────────────────────

async def test_built_in_groups_cannot_be_deleted_and_emoji_differ(db):
    user, _acct, c = await _setup(db)
    with pytest.raises(HTTPException) as exc:
        await cat_api.delete_category(c["income"].id, db=db, user=user)
    assert "built in" in exc.value.detail
    with pytest.raises(HTTPException) as exc:
        await cat_api.delete_category(c["expense"].id, db=db, user=user)
    assert exc.value.status_code == 400

    from app.modules.accounts.category_emoji import emoji_for
    assert emoji_for("Refunds") != emoji_for("Reimbursement")
    assert emoji_for("Transfer", is_group=True) != emoji_for("Transfer")
    assert (await cat_api.suggest_emoji(name="Coffee", db=db, user=user)) == {"emoji": "☕"}


# ── Issue 17: moving back puts a category where it was ──────────────────────

async def test_a_category_moved_back_goes_in_name_order(db):
    user, _acct, c = await _setup(db)
    for i, key in enumerate(("groceries", "care", "travel")):
        c[key].position = i
    await db.commit()
    for group in ("income", "expense"):
        await cat_api.move_category(c["care"].id, cat_api.CategoryMove(group_id=c[group].id, mode="keep"),
                                    db=db, user=user)
    rows = (await db.scalars(
        select(Category).where(Category.parent_id == c["expense"].id).order_by(Category.position)
    )).all()
    assert [r.name for r in rows] == ["Groceries", "Personal Care", "Travel"]


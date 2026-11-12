"""Unit tests for custom groups, emoji and moving categories.

Calls the route handlers directly against an in-memory SQLite DB, like
test_budget_profiles.
"""
from datetime import date

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as budget_api
from app.api import categories as api
from app.core.database import Base
from app.models.account import Account
from app.models.budget import BudgetLine
from app.models.category_rule import CategoryRule
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.accounts.category_emoji import emoji_for
from app.modules.accounts.seed_categories import seed_default_categories

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
    await engine.dispose()


async def _setup(db: AsyncSession):
    user = User(email="groups@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    ids = await seed_default_categories(user.id, db)
    acct = Account(user_id=user.id, account_type="checking", display_name="Chk")
    db.add(acct)
    await db.flush()
    db.add_all([
        Transaction(account_id=acct.id, date_posted=date.today(), amount=-40, description="Gym", category_id=ids["Personal Care"]),
        Transaction(account_id=acct.id, date_posted=date.today(), amount=-60, description="Gym", category_id=ids["Personal Care"]),
        CategoryRule(user_id=user.id, pattern="GYM", category_id=ids["Personal Care"]),
    ])
    await db.commit()
    return user, ids


def test_emoji_from_names():
    assert emoji_for("Groceries") == "🛒"
    assert emoji_for("Dining Out") == "🍽️"
    assert emoji_for("Something Else") == "🏷️"
    assert emoji_for("Health", is_group=True) == "🩺"
    assert emoji_for("Projects", is_group=True) == "🗂️"


async def test_seeds_are_groups_with_emoji_in_order(db):
    user, ids = await _setup(db)
    expense = await db.get(Category, ids["Expense"])
    groceries = await db.get(Category, ids["Groceries"])
    uncategorized = await db.get(Category, ids["Uncategorized"])
    assert expense.is_group and not uncategorized.is_group
    assert groceries.icon == "🛒" and not groceries.is_group
    names = [c.name for c in await api.list_categories(db=db, user=user) if c.parent_id == ids["Expense"]]
    assert names == sorted(names, key=str.lower)


async def test_a_custom_group_takes_its_behaviour_and_holds_categories(db):
    user, ids = await _setup(db)
    health = await api.create_category(
        api.CategoryCreate(name="Health", is_group=True, treatment="expense"), db=db, user=user)
    # Health & Medical already shows the stethoscope, so the group takes the next match.
    assert (health.is_group, health.treatment, health.icon) == (True, "expense", "🏥")
    gym = await api.create_category(api.CategoryCreate(name="Gym", parent_id=health.id), db=db, user=user)
    assert (gym.treatment, gym.is_income, gym.icon) == ("expense", False, "💪")
    side = await api.create_category(
        api.CategoryCreate(name="Side gigs", is_group=True, treatment="income"), db=db, user=user)
    assert side.is_income is True
    for bad in (
        api.CategoryCreate(name="Inner", parent_id=gym.id),  # no nesting below a category
        api.CategoryCreate(name="Nested", is_group=True, treatment="expense", parent_id=health.id),
        api.CategoryCreate(name="Expense", is_group=True, treatment="expense"),
    ):
        with pytest.raises(HTTPException):
            await api.create_category(bad, db=db, user=user)
    with pytest.raises(HTTPException) as exc:
        await api.create_category(api.CategoryCreate(name="No kind", is_group=True), db=db, user=user)
    assert exc.value.status_code == 422


async def test_reorder_inside_a_group(db):
    user, ids = await _setup(db)
    expense = [c for c in await api.list_categories(db=db, user=user) if c.parent_id == ids["Expense"]]
    order = [ids["Taxes"]] + [c.id for c in expense if c.id != ids["Taxes"]]
    await api.reorder_categories([api.CategoryOrder(id=i, position=p) for p, i in enumerate(order)], db=db, user=user)
    after = [c.id for c in await api.list_categories(db=db, user=user) if c.parent_id == ids["Expense"]]
    assert after == order
    with pytest.raises(HTTPException):  # one group at a time
        await api.reorder_categories([
            api.CategoryOrder(id=ids["Taxes"], position=0), api.CategoryOrder(id=ids["Other Income"], position=1),
        ], db=db, user=user)


async def _budget_with(db, user, category_id, amount=100):
    await budget_api.create_plan(budget_api.BudgetPlanIn(lines=[
        budget_api.BudgetLineIn(category_id=category_id, amount=amount, bucket="wants"),
    ]), db=db, user=user)


async def test_move_keep_changes_how_it_counts(db):
    user, ids = await _setup(db)
    await _budget_with(db, user, ids["Personal Care"])
    impact = await api.category_impact(ids["Personal Care"], db=db, user=user)
    assert impact == {"transactions": 2, "rules": 1, "budgets": ["My budget"]}

    await api.move_category(ids["Personal Care"], api.CategoryMove(group_id=ids["Income"]), db=db, user=user)
    cat = await db.get(Category, ids["Personal Care"])
    assert (cat.parent_id, cat.treatment, cat.is_income) == (ids["Income"], "income", True)
    line = await db.scalar(select(BudgetLine).where(BudgetLine.category_id == cat.id))
    assert line.hidden is True  # an income category cannot carry a budget line
    with pytest.raises(HTTPException):
        await api.move_category(ids["Personal Care"], api.CategoryMove(group_id=ids["Income"]), db=db, user=user)


async def test_move_merge_hands_everything_to_the_target(db):
    user, ids = await _setup(db)
    await _budget_with(db, user, ids["Personal Care"])
    health = await api.create_category(
        api.CategoryCreate(name="Health", is_group=True, treatment="expense"), db=db, user=user)
    fitness = await api.create_category(api.CategoryCreate(name="Fitness", parent_id=health.id), db=db, user=user)
    out = await api.move_category(
        ids["Personal Care"], api.CategoryMove(group_id=health.id, mode="merge", merge_into_id=fitness.id), db=db, user=user)
    assert out["category_id"] == fitness.id
    assert await db.get(Category, ids["Personal Care"]) is None
    txs = (await db.scalars(select(Transaction))).all()
    assert {t.category_id for t in txs} == {fitness.id}
    assert (await db.scalar(select(CategoryRule))).category_id == fitness.id
    line = await db.scalar(select(BudgetLine))
    assert (line.category_id, line.hidden) == (fitness.id, False)

    with pytest.raises(HTTPException):  # the target must be in the chosen group
        await api.move_category(
            fitness.id, api.CategoryMove(group_id=ids["Expense"], mode="merge", merge_into_id=fitness.id), db=db, user=user)


async def test_move_uncategorize_clears_and_deletes(db):
    user, ids = await _setup(db)
    await _budget_with(db, user, ids["Personal Care"])
    # "Transfer" names both the group and a category in it; the group is the top-level one.
    transfer = await db.scalar(select(Category).where(Category.name == "Transfer", Category.parent_id.is_(None)))
    await api.move_category(
        ids["Personal Care"], api.CategoryMove(group_id=transfer.id, mode="uncategorize"), db=db, user=user)
    assert await db.get(Category, ids["Personal Care"]) is None
    assert {t.category_id for t in (await db.scalars(select(Transaction))).all()} == {None}
    assert await db.scalar(select(CategoryRule)) is None
    assert await db.scalar(select(BudgetLine)) is None

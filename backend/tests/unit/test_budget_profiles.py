"""Unit tests for budget profiles — several budgets per user, one of them active.

Calls the route handlers directly against an in-memory SQLite DB (no server),
the way test_budget_progress exercises the progress math.
"""
import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as api
from app.core.database import Base
from app.models.budget import Budget
from app.models.transaction import Category
from app.models.user import User
from app.modules.budgeting.plan import get_progress

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
    await engine.dispose()


async def _user(db: AsyncSession, email: str = "bud@wwe2e.example.com"):
    user = User(email=email, hashed_password="x")
    db.add(user)
    await db.flush()
    cats = [Category(user_id=user.id, name=n, treatment="expense", color="#1") for n in ("Groceries", "Restaurants")]
    db.add_all(cats)
    await db.commit()
    return user, cats


def _line(cat, amount, bucket="needs"):
    return api.BudgetLineIn(category_id=cat.id, amount=amount, bucket=bucket)


async def _enroll(db, user, cats, total=1000):
    return await api.create_plan(
        api.BudgetPlanIn(total_target=total, lines=[_line(cats[0], 400), _line(cats[1], 200, "wants")]),
        db=db, user=user,
    )


async def test_enrolling_creates_the_active_budget(db):
    user, cats = await _user(db)
    plan = await _enroll(db, user, cats)
    assert plan["is_active"] is True
    assert plan["name"] == "My budget"
    listed = await api.list_plans(db=db, user=user)
    assert [(p["name"], p["is_active"], p["allocated"]) for p in listed["plans"]] == [("My budget", True, 600.0)]


async def test_total_and_lines_are_saved_together(db):
    """The fix for the report itself: the monthly total could not be changed
    once set, only the lines under it."""
    user, cats = await _user(db)
    await _enroll(db, user, cats, total=1000)
    plan = await api.update_plan(
        api.BudgetConfigIn(total_target=1500, lines=[_line(cats[0], 900)]), db=db, user=user,
    )
    assert plan["total_target"] == 1500.0
    assert [(ln["category_id"], ln["amount"]) for ln in plan["lines"]] == [(cats[0].id, 900.0)]
    # Settings alone leave the allocation as it was.
    plan = await api.update_plan(api.BudgetConfigIn(name="Lean months"), db=db, user=user)
    assert plan["name"] == "Lean months"
    assert len(plan["lines"]) == 1


async def test_a_copy_becomes_the_active_budget_and_leaves_the_original_alone(db):
    user, cats = await _user(db)
    first = await _enroll(db, user, cats)
    copy = await api.create_profile(api.BudgetProfileIn(name="What if", copy_from=first["id"]), db=db, user=user)
    assert copy["is_active"] is True
    assert copy["total_target"] == 1000.0
    assert len(copy["lines"]) == 2

    await api.update_plan(api.BudgetConfigIn(total_target=700, lines=[_line(cats[0], 300)]), db=db, user=user)
    listed = {p["name"]: p for p in (await api.list_plans(db=db, user=user))["plans"]}
    assert listed["What if"]["allocated"] == 300.0 and listed["What if"]["is_active"] is True
    assert listed["My budget"]["allocated"] == 600.0 and listed["My budget"]["is_active"] is False

    # Progress grades against whichever one is active.
    assert (await get_progress(db, user.id))["total_budget"] == 700.0
    await api.activate_profile(first["id"], db=db, user=user)
    assert (await get_progress(db, user.id))["total_budget"] == 1000.0


async def test_only_one_budget_can_be_active(db):
    user, cats = await _user(db)
    first = await _enroll(db, user, cats)
    await api.create_profile(api.BudgetProfileIn(copy_from=first["id"]), db=db, user=user)
    rows = (await db.scalars(select(Budget).where(Budget.user_id == user.id))).all()
    assert sum(1 for b in rows if b.is_active) == 1
    # And the database refuses a second, whatever the API does.
    for b in rows:
        b.is_active = True
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_deleting_the_active_budget_falls_back_then_unenrolls(db):
    user, cats = await _user(db)
    first = await _enroll(db, user, cats)
    await api.create_profile(api.BudgetProfileIn(name="Second", copy_from=first["id"]), db=db, user=user)

    await api.delete_plan(db=db, user=user)  # "Second" is active
    plan = await api.get_plan(db=db, user=user)
    assert plan["enrolled"] is True and plan["name"] == "My budget"

    await api.delete_plan(db=db, user=user)
    assert await api.get_plan(db=db, user=user) == {"enrolled": False}
    assert (await get_progress(db, user.id)) == {"enrolled": False}


async def test_budgets_are_private_and_capped(db):
    user, cats = await _user(db)
    other, _ = await _user(db, "other@wwe2e.example.com")
    first = await _enroll(db, user, cats)

    for call in (
        api.activate_profile(first["id"], db=db, user=other),
        api.delete_profile(first["id"], db=db, user=other),
        api.create_profile(api.BudgetProfileIn(copy_from=first["id"]), db=db, user=other),
    ):
        with pytest.raises(HTTPException) as exc:
            await call
        assert exc.value.status_code == 404

    for _ in range(api.MAX_BUDGETS - 1):
        await api.create_profile(api.BudgetProfileIn(copy_from=first["id"], activate=False), db=db, user=user)
    with pytest.raises(HTTPException) as exc:
        await api.create_profile(api.BudgetProfileIn(copy_from=first["id"]), db=db, user=user)
    assert exc.value.status_code == 409


async def test_budget_lines_reject_another_users_category(db):
    """A budget line's category must belong to the caller. Before the
    check, a foreign category_id was accepted — a cross-tenant reference."""
    user, cats = await _user(db)
    other, other_cats = await _user(db, email="intruder@wwe2e.example.com")

    # A line pointing at the other user's category is refused with 404.
    with pytest.raises(HTTPException) as e:
        await api.create_plan(
            api.BudgetPlanIn(total_target=100, lines=[_line(other_cats[0], 50)]),
            db=db, user=user,
        )
    assert e.value.status_code == 404
    # Nothing was created for the caller.
    assert (await api.list_plans(db=db, user=user))["plans"] == []

    # The caller's own category still works.
    plan = await api.create_plan(
        api.BudgetPlanIn(total_target=100, lines=[_line(cats[0], 50)]), db=db, user=user,
    )
    assert plan["is_active"] is True

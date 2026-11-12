"""Regression test for the default-category seeding.

A previous implementation did `item.pop("children")` on the shared module-level
DEFAULT_CATEGORIES, so only the *first* user ever seeded received subcategories and
every subsequent registration got just the three roots. This guards that every user
gets the full tree and that the shared template is never mutated. Runs fully
in-process against an in-memory SQLite DB — no server required.
"""
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.core.database import Base
from app.models.transaction import Category
from app.modules.accounts.seed_categories import DEFAULT_CATEGORIES, seed_default_categories

pytestmark = pytest.mark.unit


async def test_every_user_gets_full_category_tree():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    try:
        async with AsyncSession(engine) as db:
            for uid in (1, 2, 3):  # not just the first user
                await seed_default_categories(uid, db)
                await db.commit()

            for uid in (1, 2, 3):
                cats = (await db.scalars(
                    select(Category).where(Category.user_id == uid)
                )).all()
                by_name = {c.name: c for c in cats}
                names = set(by_name)
                assert {"Income", "Expense", "Transfer"} <= names
                assert "Groceries" in names and "Travel" in names  # expense children
                assert by_name["Education"].parent_id == by_name["Expense"].id
                assert by_name["Rent"].parent_id == by_name["Expense"].id
                assert by_name["Childcare"].parent_id == by_name["Expense"].id
                assert "Other Income" in names and "Other Expenses" in names  # fallbacks

                # Every category carries a budgeting treatment (drives income/
                # expense/transfer classification — never NULL on a fresh seed).
                assert all(c.treatment in {"income", "expense", "transfer"} for c in cats)
                assert by_name["Income"].treatment == "income"
                assert by_name["Groceries"].treatment == "expense"
                # Reimbursement-style inflows live under Transfer, not Income.
                assert by_name["Refunds"].treatment == "transfer"
                assert by_name["Reimbursement"].treatment == "transfer"
                assert "Refunds & Reimbursements" not in names
                assert "Expense Reimbursement" not in names
    finally:
        await engine.dispose()

    # The shared template must still carry its children after seeding.
    roots = {c["name"]: c for c in DEFAULT_CATEGORIES}
    for root in ("Income", "Expense", "Transfer"):
        assert roots[root].get("children"), f"{root} children were mutated away"

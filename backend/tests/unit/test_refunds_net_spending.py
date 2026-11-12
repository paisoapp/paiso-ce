"""A refund nets against its category's spending and is not income.

A $50 return to Amazon stays in Shopping. The Budget tab already netted it
(``_category_spend_totals``); the Income, Expenses and Cash Flow tabs used to
count it as $50 of income and leave Shopping's $200 untouched. Money in under
an income or uncategorized category is still income. Calls the modules
directly against an in-memory SQLite DB.
"""
from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from sqlalchemy import select

from app.api.transactions import _transaction_filters
from app.core.database import Base
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.aggregates import (
    get_cashflow, get_expenses, get_income, get_spending_by_day,
)

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
    await engine.dispose()


async def _seed(db):
    user = User(email="refund@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    card = Account(user_id=user.id, account_type="credit_card", display_name="Amex")
    expense = Category(user_id=user.id, name="Expense", treatment="expense", is_group=True)
    income = Category(user_id=user.id, name="Income", treatment="income", is_group=True)
    db.add_all([card, expense, income])
    await db.flush()
    shopping = Category(user_id=user.id, name="Shopping", treatment="expense", parent_id=expense.id)
    travel = Category(user_id=user.id, name="Travel", treatment="expense", parent_id=expense.id)
    salary = Category(user_id=user.id, name="Salary", treatment="income", parent_id=income.id)
    db.add_all([shopping, travel, salary])
    await db.flush()
    d1, d2 = date(2026, 9, 3), date(2026, 9, 10)
    db.add_all([
        Transaction(account_id=card.id, date_posted=d1, amount=-200, description="AMAZON",
                    category_id=shopping.id),
        Transaction(account_id=card.id, date_posted=d2, amount=50, description="AMAZON RETURN",
                    category_id=shopping.id),
        # A flight refunded in a later period than it was bought.
        Transaction(account_id=card.id, date_posted=d2, amount=500, description="DELTA REFUND",
                    category_id=travel.id),
        Transaction(account_id=card.id, date_posted=d1, amount=3000, description="PAYROLL",
                    category_id=salary.id),
        Transaction(account_id=card.id, date_posted=d2, amount=20, description="MYSTERY CREDIT"),
    ])
    await db.commit()
    return user, shopping, travel, d1, d2


async def test_refund_nets_against_spending_and_is_not_income(db):
    user, shopping, travel, d1, d2 = await _seed(db)
    start, end = date(2026, 9, 1), date(2026, 9, 30)

    income = await get_income(db, user.id, start, end)
    assert {r["category_name"]: r["total"] for r in income["by_category"]} == {
        "Salary": 3000, "Uncategorized": 20,
    }
    assert income["total"] == 3020

    expenses = await get_expenses(db, user.id, start, end)
    # Shopping nets to -150. Travel is all refund, so it is left out (the
    # Budget tab clips it at zero) rather than shown as negative spending.
    assert {r["category_name"]: r["total"] for r in expenses["by_category"]} == {"Shopping": -150}
    assert expenses["total"] == -150

    flow = await get_cashflow(db, user.id, start, end)
    assert sum(p["income"] for p in flow["series"]) == 3020
    assert sum(p["expenses"] for p in flow["series"]) == 350  # -200 + 50 + 500

    by_day = await get_spending_by_day(db, user.id, start, end)
    assert by_day == {d1: 200, d2: -550}


async def test_ledger_filters_match_the_tabs(db):
    user, *_ = await _seed(db)
    acct_ids = list((await db.scalars(select(Account.id).where(Account.user_id == user.id))).all())

    async def descriptions(sign):
        filters = await _transaction_filters(
            db=db, user=user, user_account_ids=acct_ids, account_id=None,
            account_type_group=None, category_id=None,
            date_from=date(2026, 9, 1), date_to=date(2026, 9, 30), search=None,
            uncategorized=False, exclude_transfers=True, only_transfers=False,
            only_pending=False, exclude_pending=True, amount_sign=sign,
        )
        rows = await db.scalars(select(Transaction.description).join(Account).where(*filters))
        return sorted(rows.all())

    assert await descriptions("income") == ["MYSTERY CREDIT", "PAYROLL"]
    assert await descriptions("spending") == ["AMAZON", "AMAZON RETURN", "DELTA REFUND"]

"""A loan's side of a payment is not a refund or income.

A $3,200 mortgage payment from checking shows on the mortgage account as
"PRINCIPAL PAYMENT +$600". Both carry the Mortgage category. The +$600 used to
cut the category's spending to $2,600, list in its drawer, and count as
income. Calls the modules directly against an in-memory SQLite DB.
"""
from datetime import date

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import budget as api
from app.core.database import Base
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.budgeting.aggregates import get_cashflow, get_income
from app.modules.budgeting.plan import category_detail, get_progress

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session
    await engine.dispose()


async def test_principal_on_the_loan_account_is_not_a_refund_or_income(db):
    user = User(email="loan@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()
    checking = Account(user_id=user.id, account_type="checking", display_name="Everyday Checking")
    loan = Account(user_id=user.id, account_type="mortgage", display_name="MORTGAGE LOAN")
    expense = Category(user_id=user.id, name="Expense", treatment="expense", is_group=True)
    db.add_all([checking, loan, expense])
    await db.flush()
    mortgage = Category(user_id=user.id, name="Mortgage", treatment="expense", parent_id=expense.id)
    db.add(mortgage)
    await db.flush()
    today = date.today()
    first = date(today.year, today.month, 1)
    db.add_all([
        Transaction(account_id=checking.id, date_posted=first, amount=-3200.00, description="EXAMPLE BANK MTG",
                    category_id=mortgage.id),
        Transaction(account_id=loan.id, date_posted=first, amount=600, description="PRINCIPAL PAYMENT",
                    category_id=mortgage.id),
    ])
    await db.commit()
    await api.create_plan(api.BudgetPlanIn(lines=[
        api.BudgetLineIn(category_id=mortgage.id, amount=3200, bucket="needs"),
    ]), db=db, user=user)

    line = {ln["name"]: ln for ln in (await get_progress(db, user.id))["lines"]}["Mortgage"]
    assert line["actual"] == 3200.00
    detail = await category_detail(db, user.id, mortgage.id, f"{today.year:04d}-{today.month:02d}")
    assert [t["description"] for t in detail["transactions"]] == ["EXAMPLE BANK MTG"]

    income = await get_income(db, user.id, first, today)
    assert income["total"] == 0
    flow = await get_cashflow(db, user.id, first, today)
    assert sum(p.get("income", 0) for p in flow.get("series", flow.get("daily", []))) == 0

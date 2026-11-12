"""A mortgage payment is an expense.

It was filed as "Loan Payment", under Transfer: the audit's homeowner paid
$2,000 a month and the Dashboard read "Savings Rate 80% · On track".
"""
from datetime import date, timedelta
from decimal import Decimal

from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.transfer import TransferLink
from app.models.user import User
from app.modules.accounts.categorizer import classify_transaction
from app.modules.accounts.seed_categories import seed_default_categories
from app.modules.budgeting import aggregates
from app.modules.budgeting import transfer_matcher as tm

pytestmark = pytest.mark.unit

TODAY = date(2026, 10, 1)


@pytest.fixture
async def engine():
    e = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with e.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield e
    finally:
        await e.dispose()


@pytest.fixture
async def db(engine):
    async with AsyncSession(engine, expire_on_commit=False) as session:
        yield session


@pytest.fixture
async def home(db):
    user = User(email="home@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    await seed_default_categories(user.id, db)
    checking = Account(user_id=user.id, account_type="checking", display_name="Checking (0001)")
    mortgage = Account(user_id=user.id, account_type="mortgage", display_name="Home Mortgage (0003)")
    db.add_all([checking, mortgage])
    await db.commit()
    return SimpleNamespace(user=user, checking=checking, mortgage=mortgage)


async def _cat(db, user, name) -> Category:
    return await db.scalar(select(Category).where(Category.user_id == user.id, Category.name == name))


async def _txn(db, account, amount, description, category_id=None):
    t = Transaction(
        account_id=account.id, date_posted=TODAY, amount=Decimal(str(amount)),
        description=description, transaction_type="credit" if amount > 0 else "debit",
        source="aggregator", category_id=category_id,
    )
    db.add(t)
    await db.flush()
    return t


async def test_new_users_get_mortgage_under_expense(db, home):
    mortgage = await _cat(db, home.user, "Mortgage")
    expense = await _cat(db, home.user, "Expense")
    assert mortgage.treatment == "expense" and mortgage.parent_id == expense.id


async def test_a_mortgage_payment_from_checking_is_an_expense(db, home):
    mortgage = await _cat(db, home.user, "Mortgage")
    got = await classify_transaction("EXAMPLE MORTGAGE PAYMENT", -2000, home.user.id, db)
    assert got == mortgage.id


async def test_the_mortgage_accounts_own_side_stays_a_transfer(db, home):
    """Filed as an expense too, the arriving side would cancel the payment out."""
    loan_payment = await _cat(db, home.user, "Loan Payment")
    got = await classify_transaction("PAYMENT RECEIVED - MORTGAGE", 2000, home.user.id, db)
    assert got == loan_payment.id


async def test_a_paired_mortgage_payment_counts_once_as_an_expense(db, home):
    outflow = await _txn(db, home.checking, -2000, "ACH PMT 0291")
    inflow = await _txn(db, home.mortgage, 2000, "PAYMENT RECEIVED")
    link = TransferLink(
        user_id=home.user.id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("2000"), kind="loan_payment", confidence=Decimal("0.9"),
        status="confirmed", source="auto",
    )
    db.add(link)
    await db.commit()
    await tm.apply_transfer_categories(db, link)
    await db.commit()

    assert outflow.category_id == (await _cat(db, home.user, "Mortgage")).id
    assert inflow.category_id == (await _cat(db, home.user, "Loan Payment")).id

    spent = await aggregates.get_expenses(db, home.user.id, TODAY - timedelta(days=1), TODAY)
    # Spending is reported as a negative total.
    assert spent["total"] == pytest.approx(-2000)


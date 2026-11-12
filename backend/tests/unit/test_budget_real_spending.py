"""Budget averages, progress and history count real spending only.

Both legs of a transfer used to add up — a $2,000 mortgage payment showed as
$4,000 of "Loan Payment", a card autopay counted on top of the card purchases
it paid for — and months before the budget existed were graded against it.
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
from app.modules.budgeting.plan import (
    add_months,
    compute_recommendations,
    get_history,
    get_progress,
)

pytestmark = pytest.mark.unit


async def _setup(db: AsyncSession, *, start_month: date) -> dict:
    user = User(email="real@wwe2e.example.com", hashed_password="x")
    db.add(user)
    await db.flush()

    accts = {}
    for kind in ("checking", "savings", "mortgage", "credit_card"):
        a = Account(user_id=user.id, account_type=kind, display_name=kind)
        db.add(a)
        accts[kind] = a
    await db.flush()

    expense = Category(user_id=user.id, name="Expense", treatment="expense")
    transfer = Category(user_id=user.id, name="Transfer", treatment="transfer")
    db.add_all([expense, transfer])
    await db.flush()
    cats = {}
    for name, parent in (("Restaurants", expense), ("Groceries", expense)):
        cats[name] = Category(user_id=user.id, name=name, treatment="expense", parent_id=parent.id)
    for name in ("Loan Payment", "Credit Card Payment", "Savings", "Transfer"):
        cats[name] = Category(user_id=user.id, name=name, treatment="transfer", parent_id=transfer.id)
    db.add_all(cats.values())
    await db.flush()

    budget = Budget(user_id=user.id, total_target=3000, income_basis="manual", start_month=start_month)
    db.add(budget)
    await db.flush()
    db.add_all([
        BudgetLine(user_id=user.id, budget_id=budget.id, category_id=cats["Loan Payment"].id,
                   amount=2000, bucket="needs"),
        BudgetLine(user_id=user.id, budget_id=budget.id, category_id=cats["Restaurants"].id,
                   amount=200, bucket="wants"),
        # Saved by the old "Use my averages", before card payments were excluded.
        BudgetLine(user_id=user.id, budget_id=budget.id, category_id=cats["Credit Card Payment"].id,
                   amount=500, bucket="needs"),
    ])
    await db.flush()
    return {"user_id": user.id, "accts": accts, "cats": cats}


def _month_of_spending(ctx: dict, day: date) -> list[Transaction]:
    a, c = ctx["accts"], ctx["cats"]

    def tx(acct, amount, cat, desc, pending=False):
        return Transaction(account_id=a[acct].id, date_posted=day, amount=amount,
                           description=desc, category_id=c[cat].id, pending=pending)

    return [
        # One mortgage payment, seen from both ends.
        tx("checking", -2000, "Loan Payment", "EXAMPLE MORTGAGE"),
        tx("mortgage", 2000, "Loan Payment", "PAYMENT RECEIVED"),
        # Card autopay, both ends: the purchases it pays for are already counted.
        tx("checking", -500, "Credit Card Payment", "CARD AUTOPAY"),
        tx("credit_card", 500, "Credit Card Payment", "PAYMENT THANK YOU"),
        # A move into savings, both ends.
        tx("checking", -300, "Savings", "TRANSFER TO SAV"),
        tx("savings", 300, "Savings", "TRANSFER FROM CHK"),
        # Restaurants on the card, one refunded.
        tx("credit_card", -90, "Restaurants", "BISTRO"),
        tx("credit_card", 30, "Restaurants", "BISTRO REFUND"),
        # A hold that has not settled moves nothing.
        tx("credit_card", -1000, "Groceries", "HOLD", pending=True),
    ]


async def _db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    return engine


async def test_averages_count_each_payment_once_and_skip_card_payments():
    engine = await _db()
    try:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            today = date.today()
            ctx = await _setup(db, start_month=date(today.year, today.month, 1))
            # Three whole months of identical spending: the trailing window.
            for delta in (-1, -2, -3):
                y, m = add_months(today.year, today.month, delta)
                db.add_all(_month_of_spending(ctx, date(y, m, 10)))
            await db.commit()

            recs = {r["name"]: r for r in await compute_recommendations(db, ctx["user_id"], income=6500)}

            assert recs["Loan Payment"]["trailing_avg"] == 2000.0
            assert recs["Savings"]["trailing_avg"] == 300.0
            assert recs["Restaurants"]["trailing_avg"] == 60.0  # 90 − 30 refund
            assert recs["Groceries"]["trailing_avg"] == 0.0  # pending only
            assert "Credit Card Payment" not in recs
            assert "Transfer" not in recs
            # Whole dollars, never cents or raw decimals.
            for r in recs.values():
                assert r["trailing_avg"] == int(r["trailing_avg"])
                if r["benchmark"] is not None:
                    assert r["benchmark"] == int(r["benchmark"])
    finally:
        await engine.dispose()


async def test_progress_counts_mortgage_once_and_ignores_card_payment_line():
    engine = await _db()
    try:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            today = date.today()
            ctx = await _setup(db, start_month=date(today.year, today.month, 1))
            db.add_all(_month_of_spending(ctx, date(today.year, today.month, 1)))
            await db.commit()

            data = await get_progress(db, ctx["user_id"], f"{today.year:04d}-{today.month:02d}")
            lines = {l["name"]: l for l in data["lines"]}

            assert lines["Loan Payment"]["actual"] == 2000.0
            assert lines["Restaurants"]["actual"] == 60.0
            assert "Credit Card Payment" not in lines
            assert data["total_spent"] == 2060.0
            assert data["allocated"] == 2200.0
            assert data["before_start"] is False
    finally:
        await engine.dispose()


async def test_history_does_not_grade_months_before_the_budget():
    engine = await _db()
    try:
        async with AsyncSession(engine, expire_on_commit=False) as db:
            today = date.today()
            ctx = await _setup(db, start_month=date(today.year, today.month, 1))
            for delta in (0, -1, -2):
                y, m = add_months(today.year, today.month, delta)
                db.add_all(_month_of_spending(ctx, date(y, m, 1)))
            await db.commit()

            months = (await get_history(db, ctx["user_id"], months=3))["months"]
            assert [m["status"] for m in months[:2]] == ["no_budget", "no_budget"]
            assert months[2]["is_current"] is True
            assert months[2]["status"] == "excelled"  # 2,060 of 3,000
            assert months[2]["total_spent"] == 2060.0
            # Not graded, but its spending is there for comparison.
            assert months[0]["before_start"] is True and months[0]["total_spent"] == 2060.0

            py, pm = add_months(today.year, today.month, -1)
            prior = await get_progress(db, ctx["user_id"], f"{py:04d}-{pm:02d}")
            assert prior["before_start"] is True
    finally:
        await engine.dispose()

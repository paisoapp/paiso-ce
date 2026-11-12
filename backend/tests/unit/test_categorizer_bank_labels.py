"""Categorization from a bank's own labels, card payments and merchant words.

A card import filed card payments as Other Income, grocery stores and
restaurants as Other Expenses, and a money transfer abroad as Travel. Calls the
categorizer, the import endpoint and find_similar against SQLite.
"""
from datetime import date
from decimal import Decimal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.models  # noqa: F401 — register ORM mappers
from app.api import imports as imports_api
from app.api import transactions as transactions_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.accounts.categorizer import classify_transaction, normalize_bank_label
from app.modules.accounts.seed_categories import seed_default_categories
from app.modules.aggregator.csv_parsers import parse_csv_auto_with_institution

pytestmark = pytest.mark.unit


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cat.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def setup(sessionmaker):
    async with sessionmaker() as db:
        user = User(email="labels@example.com", hashed_password="x", token_family="f")
        db.add(user)
        await db.flush()
        await seed_default_categories(user.id, db)
        card = Account(user_id=user.id, display_name="Card", account_type="credit_card",
                       current_balance=Decimal("0"))
        checking = Account(user_id=user.id, display_name="Checking", account_type="checking",
                           current_balance=Decimal("0"))
        db.add_all([card, checking])
        await db.commit()
        return user.id, card.id, checking.id


async def _name(db: AsyncSession, category_id: int | None) -> str | None:
    if category_id is None:
        return None
    return (await db.get(Category, category_id)).name


async def _classify(sessionmaker, user_id, description, amount, **kwargs) -> str | None:
    async with sessionmaker() as db:
        return await _name(db, await classify_transaction(description, amount, user_id, db, **kwargs))


# ── Item 3: card payments ───────────────────────────────────────────────────

@pytest.mark.parametrize("description", [
    "Payment Thank You-Mobile",
    "AUTOMATIC PAYMENT - THANK",
    "CHASE CREDIT CRD AUTOPAY 12345",
    "Payment to Chase card ending in 1234",
])
async def test_card_payment_wording(sessionmaker, setup, description):
    user_id, _, _ = setup
    assert await _classify(sessionmaker, user_id, description, 250.0) == "Credit Card Payment"


async def test_money_arriving_on_a_card_is_never_income(sessionmaker, setup):
    user_id, _, _ = setup
    on_card = await _classify(sessionmaker, user_id, "ZQX 4471", 80.0, account_type="credit_card")
    on_checking = await _classify(sessionmaker, user_id, "ZQX 4471", 80.0, account_type="checking")
    assert (on_card, on_checking) == ("Credit Card Payment", "Other Income")


async def test_bank_type(sessionmaker, setup):
    user_id, _, _ = setup
    assert await _classify(sessionmaker, user_id, "ZQX", 50.0, bank_type="Payment") == "Credit Card Payment"
    assert await _classify(sessionmaker, user_id, "ZQX", 20.0, bank_type="Return") == "Refunds"
    assert await _classify(sessionmaker, user_id, "ZQX", -5.0, bank_type="Fee") == "Fees & Charges"
    # An OFX PAYMENT leaving checking is a bill paid, not a card payment.
    assert await _classify(sessionmaker, user_id, "ZQX", -90.0, bank_type="PAYMENT") == "Other Expenses"


# ── Item 4: the bank's own category ─────────────────────────────────────────

@pytest.mark.parametrize(("label", "expected"), [
    ("Food & Drink", "Restaurants"),                      # Chase
    ("Groceries", "Groceries"),                           # Chase
    ("Education", "Education"),                           # Chase
    ("Dining", "Restaurants"),                            # Capital One
    ("Supermarkets", "Groceries"),                        # Discover
    ("Merchandise & Supplies-Groceries", "Groceries"),    # Amex
    ("Childcare", "Childcare"),                           # no map row: names a category
    ("Miscellaneous", "Other Expenses"),                  # falls through
])
async def test_bank_category(sessionmaker, setup, label, expected):
    user_id, _, _ = setup
    assert await _classify(sessionmaker, user_id, "ZQX 991", -12.0, bank_category=label) == expected


async def test_money_movement_beats_the_bank_label(sessionmaker, setup):
    user_id, _, _ = setup
    assert await _classify(
        sessionmaker, user_id, "Zelle payment to Sam", -300.0, bank_category="Travel",
    ) == "Transfer"


def test_bank_label_normalising():
    assert normalize_bank_label("Merchandise & Supplies-Groceries") == "groceries"
    assert normalize_bank_label("Gas/Automotive") == "gas automotive"
    assert normalize_bank_label("  ") == ""


# ── Item 4: merchant words ──────────────────────────────────────────────────

@pytest.mark.parametrize(("description", "expected"), [
    ("KROGER #123 SPRINGFIELD", "Groceries"),
    ("OLIVE BURGER", "Restaurants"),
    ("CORNER KEBAB", "Restaurants"),
    ("MAIN STREET COFFEE", "Restaurants"),
    ("OAK APARTMENTS 0042", "Rent"),
    ("STATE UNIVERSITY TUITION", "Education"),
    ("BRIGHT HORIZONS 0001", "Childcare"),
    ("UNITED AIRLINES 0001", "Travel"),
    ("ENTERPRISE RENT-A-CAR", "Travel"),
    # A bare "united" was read as the airline.
    ("ZQX SENDER UNITED STATES", "Other Expenses"),
])
async def test_merchant_words(sessionmaker, setup, description, expected):
    user_id, _, _ = setup
    assert await _classify(sessionmaker, user_id, description, -40.0) == expected


# ── History learns only from the user's choices ─────────────────────────────

async def test_history_ignores_the_importers_guesses(sessionmaker, setup):
    user_id, _, checking_id = setup
    async with sessionmaker() as db:
        travel = await db.scalar(select(Category.id).where(Category.user_id == user_id, Category.name == "Travel"))
        db.add(Transaction(account_id=checking_id, date_posted=date(2026, 10, 1), amount=Decimal("-10"),
                           description="ZQX MART", category_id=travel, category_source="auto"))
        await db.commit()
    assert await _classify(sessionmaker, user_id, "ZQX MART", -10.0) == "Other Expenses"

    async with sessionmaker() as db:
        db.add(Transaction(account_id=checking_id, date_posted=date(2026, 10, 2), amount=Decimal("-10"),
                           description="ZQX MART", category_id=travel, category_source="user"))
        await db.commit()
    assert await _classify(sessionmaker, user_id, "ZQX MART", -10.0) == "Travel"


# ── Parsers pass the label on, and the import keeps it ──────────────────────

CHASE_CARD = """Transaction Date,Post Date,Description,Category,Type,Amount,Memo
10/20/2026,10/21/2026,H-E-B #123,Groceries,Sale,-54.20,
10/21/2026,10/22/2026,ZQX TUTORING,Education,Sale,-120.00,
10/22/2026,10/22/2026,Payment Thank You-Mobile,,Payment,500.00,
"""

CAPITAL_ONE = """Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit
2026-10-20,2026-10-21,1234,ZQX BISTRO,Dining,18.40,
"""


def test_parsers_keep_the_bank_label():
    chase, institution = parse_csv_auto_with_institution(CHASE_CARD)
    assert institution == "Chase"
    assert [t.bank_category for t in chase] == ["Groceries", "Education", ""]
    capital_one, _ = parse_csv_auto_with_institution(CAPITAL_ONE)
    assert [t.bank_category for t in capital_one] == ["Dining"]


async def test_chase_card_import(sessionmaker, setup):
    _, card_id, _ = setup
    app = FastAPI()
    app.include_router(imports_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    async def _user():
        async with sessionmaker() as s:
            return await s.scalar(select(User))

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://app.test") as c:
        r = await c.post("/api/imports/bank-csv", data={"account_id": str(card_id)},
                         files={"file": ("chase.csv", CHASE_CARD.encode(), "text/csv")})
    assert r.status_code == 200, r.text

    async with sessionmaker() as db:
        rows = (await db.execute(
            select(Transaction.description, Category.name, Transaction.bank_category)
            .join(Category, Transaction.category_id == Category.id)
            .where(Transaction.account_id == card_id)
            .order_by(Transaction.date_posted)
        )).all()
    assert [tuple(r) for r in rows] == [
        ("H-E-B #123", "Groceries", "Groceries"),
        ("ZQX TUTORING", "Education", "Education"),
        ("Payment Thank You-Mobile", "Credit Card Payment", None),
    ]


# ── "Similar" uses the merchant key ─────────────────────────────────────────

async def test_find_similar_sees_past_reference_codes(sessionmaker, setup):
    user_id, _, checking_id = setup
    async with sessionmaker() as db:
        rows = [
            Transaction(account_id=checking_id, date_posted=date(2026, m, 1), amount=Decimal("-1800"),
                        description=f"Zelle payment to Oak Apartments JPM99{m}x7k2")
            for m in (8, 9, 10)
        ] + [
            Transaction(account_id=checking_id, date_posted=date(2026, 10, d), amount=Decimal("-30"),
                        description=f"H-E-B #{d}")
            for d in (3, 4)
        ] + [
            Transaction(account_id=checking_id, date_posted=date(2026, 10, 5), amount=Decimal("-9"),
                        description="Zelle payment to Sam JPM99q1"),
        ]
        db.add_all(rows)
        await db.commit()
        user = await db.get(User, user_id)
        rent = await transactions_api.find_similar(rows[0].id, db=db, user=user, user_account_ids=[checking_id])
        heb = await transactions_api.find_similar(rows[3].id, db=db, user=user, user_account_ids=[checking_id])
    # Newest first, each with what the drawer shows.
    assert (rent["count"], rent["ids"]) == (2, [rows[2].id, rows[1].id])
    assert [t["date_posted"] for t in rent["transactions"]] == ["2026-10-01", "2026-09-01"]
    assert rent["transactions"][0]["account_name"] == "Checking"
    assert (heb["count"], heb["ids"]) == (1, [rows[4].id])

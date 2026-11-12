"""spending so far this month, day by day, beside last month."""
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import dashboard as dashboard_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.user import User

pytestmark = pytest.mark.unit


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 's.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def setup(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="s@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.flush()
        card = Account(user_id=u.id, display_name="Card", account_type="credit_card")
        food = Category(user_id=u.id, name="Groceries", treatment="expense")
        payment = Category(user_id=u.id, name="Credit Card Payment", treatment="transfer")
        db.add_all([card, food, payment])
        await db.commit()
        return u, card, food, payment


@pytest.fixture
async def client(sessionmaker, setup):
    user = setup[0]
    app = FastAPI()
    app.include_router(dashboard_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://t") as c:
        yield c


async def test_running_totals_skip_transfers_and_pending(client, sessionmaker, setup):
    _, card, food, payment = setup
    async with sessionmaker() as db:
        db.add_all([
            # February: 28 days.
            Transaction(account_id=card.id, date_posted=date(2026, 2, 3), amount=-100, category_id=food.id),
            Transaction(account_id=card.id, date_posted=date(2026, 2, 28), amount=-50, category_id=food.id),
            # March.
            Transaction(account_id=card.id, date_posted=date(2026, 3, 2), amount=-40, category_id=food.id),
            Transaction(account_id=card.id, date_posted=date(2026, 3, 2), amount=-10),  # uncategorized counts
            Transaction(account_id=card.id, date_posted=date(2026, 3, 5), amount=-500, category_id=payment.id),
            Transaction(account_id=card.id, date_posted=date(2026, 3, 6), amount=-70, category_id=food.id, pending=True),
            Transaction(account_id=card.id, date_posted=date(2026, 3, 9), amount=25, category_id=food.id),  # refund: nets against spending
            Transaction(account_id=card.id, date_posted=date(2026, 3, 31), amount=-5, category_id=food.id),
        ])
        await db.commit()

    r = (await client.get("/api/dashboard/spending-pace?month=2026-03")).json()
    assert r["month"] == "2026-03" and r["previous_month"] == "2026-02"
    assert r["days_in_month"] == 31 and r["through_day"] == 31
    totals = {p["day"]: p["total"] for p in r["current"]}
    assert totals[1] == 0 and totals[2] == 50 and totals[8] == 50 and totals[9] == 25
    assert totals[30] == 25 and totals[31] == 30
    assert r["total"] == 30
    assert len(r["previous"]) == 28 and r["previous_total"] == 150
    # Day 31 has no February twin: compare with February's last day.
    assert r["previous_to_date"] == 150


async def test_a_month_not_started_is_refused(client):
    assert (await client.get("/api/dashboard/spending-pace?month=2999-01")).status_code == 400
    assert (await client.get("/api/dashboard/spending-pace?month=2026-13")).status_code == 400
    assert (await client.get("/api/dashboard/spending-pace?month=March")).status_code == 422


async def test_the_current_month_runs_to_today(client):
    r = (await client.get("/api/dashboard/spending-pace")).json()
    today = date.today()
    assert r["month"] == today.strftime("%Y-%m")
    assert r["through_day"] == today.day and len(r["current"]) == today.day
    assert r["total"] == 0

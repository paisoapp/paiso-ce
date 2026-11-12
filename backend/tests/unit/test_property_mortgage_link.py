"""A property's mortgage is counted once, and leaves with its account.

Add Property → Mortgage always made a second, hand-entered mortgage account,
so a homeowner who had already added the mortgage account had the debt
counted twice. And deleting the mortgage account behind a property left the property's
loan behind, still counted, with no way to remove it.
"""

from decimal import Decimal


import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import accounts as accounts_api
from app.api import assets as assets_api
from app.api import mortgage as mortgage_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.asset import Asset, Loan, PaymentSchedule
from app.models.user import User
from app.modules.portfolio.linked_loans import sync_linked_loan
from app.modules.portfolio.summary import get_portfolio_summary

pytestmark = pytest.mark.unit

HOME = {
    "property_address": "742 Evergreen Terrace",
    "category": "primary_home",
    "current_value": 650000,
    "principal": 416000,
    "rate_apr": 3.25,
    "term_months": 360,
    "origination": "2019-06-01",
}


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'home.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def user(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="home@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.commit()
        return u


@pytest.fixture
async def client(sessionmaker, user):
    app = FastAPI()
    for r in (accounts_api.router, assets_api.router, mortgage_api.router):
        app.include_router(r)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test"
    ) as c:
        yield c


async def _separate_mortgage(sessionmaker, user, balance="300000") -> int:
    """A mortgage account added on its own, not through the property form."""
    async with sessionmaker() as db:
        acct = Account(user_id=user.id, display_name="Home Mortgage (0003)",
                       account_type="mortgage",
                       current_balance=Decimal(balance))
        db.add(acct)
        await db.commit()
        return acct.id


async def _summary(sessionmaker, user) -> dict:
    async with sessionmaker() as db:
        return await get_portfolio_summary(user.id, db)


# ── use the mortgage the user already has ─────────────────────────────

async def test_a_property_on_the_separate_mortgage_counts_the_debt_once(client, sessionmaker, user):
    mortgage_id = await _separate_mortgage(sessionmaker, user)

    r = await client.post("/api/mortgage", json={**HOME, "account_id": mortgage_id})
    assert r.status_code == 201, r.text
    assert r.json()["account"]["id"] == mortgage_id

    async with sessionmaker() as db:
        accounts = (await db.scalars(select(Account).where(Account.user_id == user.id))).all()
        assert len(accounts) == 1, "no second mortgage account"
        assert accounts[0].linked_asset_id is not None

    out = await _summary(sessionmaker, user)
    assert out["total_liabilities"] == pytest.approx(300000.0)
    assert out["net_worth"] == pytest.approx(650000.0 - 300000.0)

    homes = (await client.get("/api/assets")).json()
    assert homes[0]["loan"]["current_balance"] == pytest.approx(300000.0)


async def test_the_property_loan_follows_the_account_balance(client, sessionmaker, user):
    mortgage_id = await _separate_mortgage(sessionmaker, user)
    await client.post("/api/mortgage", json={**HOME, "account_id": mortgage_id})

    # A balance sync lowers what is owed.
    async with sessionmaker() as db:
        acct = await db.get(Account, mortgage_id)
        acct.current_balance = Decimal("310000")
        assert await sync_linked_loan(db, acct) is True
        assert await sync_linked_loan(db, acct) is False  # nothing new to do
        await db.commit()

    out = await _summary(sessionmaker, user)
    assert out["total_liabilities"] == pytest.approx(310000.0)

    # And so does a balance typed by hand.
    r = await client.patch(f"/api/accounts/{mortgage_id}", json={"current_balance": 305000})
    assert r.status_code == 200, r.text
    out = await _summary(sessionmaker, user)
    assert out["total_liabilities"] == pytest.approx(305000.0)


async def test_a_mortgage_already_behind_a_property_cannot_back_another(client, sessionmaker, user):
    mortgage_id = await _separate_mortgage(sessionmaker, user)
    assert (await client.post("/api/mortgage", json={**HOME, "account_id": mortgage_id})).status_code == 201
    r = await client.post("/api/mortgage", json={**HOME, "property_address": "Second Home", "account_id": mortgage_id})
    assert r.status_code == 409


async def test_only_a_loan_account_can_back_a_property(client, sessionmaker, user):
    async with sessionmaker() as db:
        chk = Account(user_id=user.id, display_name="Checking", account_type="checking")
        db.add(chk)
        await db.commit()
    r = await client.post("/api/mortgage", json={**HOME, "account_id": chk.id})
    assert r.status_code == 404


# ── the loan leaves with its account ──────────────────────────────────

async def _manual_home(client) -> tuple[int, int]:
    r = await client.post("/api/mortgage", json={**HOME, "display_name": "742 Evergreen Terrace"})
    assert r.status_code == 201, r.text
    body = r.json()
    return body["account"]["id"], body["asset"]["id"]


async def test_deleting_the_mortgage_account_keeps_the_home_owned_outright(client, sessionmaker, user):
    account_id, asset_id = await _manual_home(client)
    assert (await _summary(sessionmaker, user))["total_liabilities"] > 300000

    assert (await client.delete(f"/api/accounts/{account_id}")).status_code == 204

    out = await _summary(sessionmaker, user)
    assert out["total_liabilities"] == 0.0
    async with sessionmaker() as db:
        asset = await db.get(Asset, asset_id)
        assert asset is not None
        assert await db.scalar(select(Loan).where(Loan.asset_id == asset_id)) is None
        assert (await db.scalars(select(PaymentSchedule))).all() == []


async def test_deleting_the_mortgage_account_can_take_the_home_too(client, sessionmaker, user):
    account_id, asset_id = await _manual_home(client)
    r = await client.delete(f"/api/accounts/{account_id}?delete_property=true")
    assert r.status_code == 204
    async with sessionmaker() as db:
        assert await db.get(Asset, asset_id) is None
        assert (await db.scalars(select(Loan))).all() == []
    assert (await _summary(sessionmaker, user))["total_liabilities"] == 0.0


async def test_deleting_a_home_can_delete_its_hand_added_mortgage_account(client, sessionmaker, user):
    account_id, asset_id = await _manual_home(client)
    r = await client.delete(f"/api/assets/{asset_id}?delete_accounts=true")
    assert r.status_code == 204
    async with sessionmaker() as db:
        assert await db.get(Account, account_id) is None
        assert await db.get(Asset, asset_id) is None


# ── values, terms and dates a user can correct ────────────────────────

@pytest.mark.parametrize("bad", [
    {"current_value": -650000},
    {"current_value": 0},
    {"acquired_value": -1},
    {"ownership_pct": 150},
    {"principal": 0},
    {"rate_apr": 325},
    {"term_months": 0},
    {"property_address": ""},
])
async def test_add_property_with_a_mortgage_refuses_impossible_values(client, bad):
    """The mortgage route took any number: the audit saved a -$650,000 home
    with a 150% share."""
    r = await client.post("/api/mortgage", json={**HOME, **bad})
    assert r.status_code == 422, r.text


async def test_a_home_is_never_worth_nothing_or_less(client):
    for value in (-650000, 0):
        r = await client.post("/api/assets", json={
            "category": "primary_home", "name": "Home", "current_value": value,
        })
        assert r.status_code == 422, r.text
    r = await client.post("/api/assets", json={
        "category": "primary_home", "name": "Home", "current_value": 650000,
    })
    assert r.status_code == 201, r.text
    r = await client.patch(f"/api/assets/{r.json()['id']}", json={"current_value": -1})
    assert r.status_code == 422, r.text


async def test_editing_a_home_corrects_its_purchase_and_its_loan_terms(client):
    created = (await client.post("/api/mortgage", json=HOME)).json()
    asset_id = created["asset"]["id"]

    r = await client.patch(f"/api/assets/{asset_id}", json={
        "acquired_value": 520000,
        "acquired_at": "2019-06-01",
        "loan": {"principal": 400000, "rate_apr": 6.5, "term_months": 180,
                 "origination": "2020-01-01"},
    })
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["acquired_value"] == pytest.approx(520000)
    assert out["acquired_at"].startswith("2019-06-01")
    loan = out["loan"]
    assert (loan["principal"], loan["rate_apr"], loan["term_months"], loan["origination"]) == (
        pytest.approx(400000), pytest.approx(6.5), 180, "2020-01-01")
    # The schedule was rebuilt from the new terms.
    assert len(loan["schedule"]) == 180
    first = loan["schedule"][0]
    # 400,000 at 6.5% over 15 years: $3,484.43 a month.
    assert first["principal"] + first["interest"] == pytest.approx(3484.43, abs=0.01)

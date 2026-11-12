"""the Loan and Mortgage tabs total what was paid and what was
charged, and do not count a mortgage payment twice when both the bank's
payment and the lender's credit for it are listed."""
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import transactions as transactions_api
from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.account_liability import AccountLiability
from app.models.account_balance import AccountBalanceSnapshot
from app.models.asset import Asset, Loan, PaymentSchedule
from app.models.transaction import Transaction
from app.models.user import User

pytestmark = pytest.mark.unit

@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'd.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def accounts(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="d@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.flush()
        checking = Account(user_id=u.id, display_name="Checking", account_type="checking")
        # Bank-side payments reach the Mortgage tab through the pattern.
        home = Account(user_id=u.id, display_name="Home", account_type="mortgage",
                       description_pattern="MTG")
        second = Account(user_id=u.id, display_name="Second Mortgage", account_type="mortgage")
        db.add_all([checking, home, second])
        await db.commit()
        return u, checking, home, second


@pytest.fixture
async def client(sessionmaker, accounts):
    user, checking, home, second = accounts
    app = FastAPI()
    app.include_router(transactions_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_user_account_ids] = lambda: [checking.id, home.id, second.id]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://t") as c:
        yield c


async def _add(sessionmaker, *rows):
    async with sessionmaker() as db:
        db.add_all(list(rows))
        await db.commit()


async def test_a_payment_listed_on_both_sides_counts_once(client, sessionmaker, accounts):
    _, checking, home, _ = accounts
    await _add(
        sessionmaker,
        # The bank pays on the 1st; the lender credits it on the 2nd.
        Transaction(account_id=checking.id, date_posted=date(2026, 9, 1), amount=-2000,
                    description="MTG PMT"),
        Transaction(account_id=home.id, date_posted=date(2026, 9, 2), amount=2000, description="PAYMENT"),
        Transaction(account_id=home.id, date_posted=date(2026, 9, 15), amount=-400, description="ESCROW TAX"),
    )
    r = (await client.get("/api/transactions/breakdown?account_type_group=mortgage&group_by=account")).json()
    debt = {k: r["debt"][k] for k in ("paid", "charged", "net_paid", "matched_payments")}
    assert debt == {"paid": 2000.0, "charged": 400.0, "net_paid": 1600.0, "matched_payments": 1}
    # The plain totals still describe every listed row.
    assert r["total_inflow"] == 2000.0 and r["total_outflow"] == 2400.0


async def test_a_payment_with_no_lender_credit_counts_as_paid(client, sessionmaker, accounts):
    _, checking, home, second = accounts
    await _add(
        sessionmaker,
        # Home is linked and credits its payment; the second mortgage is kept by hand
        # and only the bank's side of its payment exists.
        Transaction(account_id=checking.id, date_posted=date(2026, 9, 1), amount=-2000,
                    description="HOME MTG"),
        Transaction(account_id=home.id, date_posted=date(2026, 9, 1), amount=2000, description="PAYMENT"),
        Transaction(account_id=checking.id, date_posted=date(2026, 9, 3), amount=-800,
                    description="SECOND MTG"),
        # Same amount as the home payment, but weeks away: a different payment.
        Transaction(account_id=checking.id, date_posted=date(2026, 9, 28), amount=-2000,
                    description="HOME MTG"),
    )
    r = (await client.get("/api/transactions/breakdown?account_type_group=mortgage")).json()
    assert r["debt"]["paid"] == 2000.0 + 800.0 + 2000.0
    assert r["debt"]["matched_payments"] == 1


async def test_other_tabs_have_no_debt_totals(client, sessionmaker, accounts):
    _, checking, _, _ = accounts
    await _add(sessionmaker, Transaction(account_id=checking.id, date_posted=date(2026, 9, 1), amount=-5, description="X"))
    assert "debt" not in (await client.get("/api/transactions/breakdown?account_type_group=cash")).json()
    assert "debt" not in (await client.get("/api/transactions/breakdown")).json()


# ── Principal and interest ─────────────────────────────────────

def _split_url(date_from: str, date_to: str) -> str:
    return f"/api/transactions/breakdown?account_type_group=mortgage&date_from={date_from}&date_to={date_to}"


async def _one_payment(sessionmaker, home, on: date, amount: float = 2000):
    await _add(sessionmaker, Transaction(account_id=home.id, date_posted=on, amount=amount, description="PAYMENT"))


async def test_the_lenders_own_figures_are_used_for_this_year_so_far(client, sessionmaker, accounts):
    _, _, home, _ = accounts
    today = date.today()
    await _one_payment(sessionmaker, home, today.replace(day=1))
    async with sessionmaker() as db:
        db.add(AccountLiability(account_id=home.id, kind="mortgage", ytd_interest_paid=9000, ytd_principal_paid=3000))
        await db.commit()
    split = (await client.get(_split_url(f"{today.year}-01-01", today.isoformat()))).json()["debt"]["split"]
    assert split["basis"] == "reported" and split["estimated"] is False
    assert split["principal"] == 3000 and split["interest"] == 9000


async def test_another_range_uses_the_lenders_share_as_an_estimate(client, sessionmaker, accounts):
    _, _, home, _ = accounts
    await _one_payment(sessionmaker, home, date(2026, 3, 1))
    async with sessionmaker() as db:
        db.add(AccountLiability(account_id=home.id, kind="mortgage", ytd_interest_paid=9000, ytd_principal_paid=3000))
        await db.commit()
    split = (await client.get(_split_url("2026-03-01", "2026-03-31"))).json()["debt"]["split"]
    assert split["basis"] == "lender_share" and split["estimated"] is True
    assert split["interest"] == 1500 and split["principal"] == 500


async def test_loan_details_under_property_set_the_shares(client, sessionmaker, accounts):
    user, _, home, second = accounts
    await _one_payment(sessionmaker, home, date(2026, 3, 1))
    async with sessionmaker() as db:
        asset = Asset(user_id=user.id, category="primary_home", name="Home")
        db.add(asset)
        await db.flush()
        loan = Loan(asset_id=asset.id, principal=300000, rate_apr=6, term_months=360, origination=date(2020, 1, 1))
        db.add(loan)
        await db.flush()
        db.add(PaymentSchedule(loan_id=loan.id, month_number=75, payment_date=date(2026, 3, 1),
                               principal=500, interest=1200, escrow=300, balance=250000))
        (await db.get(Account, home.id)).linked_asset_id = asset.id
        await db.commit()
    split = (await client.get(_split_url("2026-03-01", "2026-03-31"))).json()["debt"]["split"]
    assert split["basis"] == "loan_details" and split["estimated"] is True
    assert (split["principal"], split["interest"], split["other"]) == (500, 1200, 300)


async def test_with_nothing_else_the_balance_fall_is_principal(client, sessionmaker, accounts):
    _, _, home, _ = accounts
    await _one_payment(sessionmaker, home, date(2026, 3, 2))
    async with sessionmaker() as db:
        db.add_all([
            AccountBalanceSnapshot(account_id=home.id, as_of=date(2026, 3, 1), balance=250000),
            AccountBalanceSnapshot(account_id=home.id, as_of=date(2026, 3, 31), balance=249400),
        ])
        await db.commit()
    split = (await client.get(_split_url("2026-03-01", "2026-03-31"))).json()["debt"]["split"]
    assert split["basis"] == "balance" and split["estimated"] is True
    assert split["principal"] == 600 and split["interest"] == 1400


# ── Each payment split from the loan's terms ──────────────────────────

async def _sample_loan(sessionmaker, user, home):
    """$300,000 at 3% over 180 months, $198,450.00 owed after September."""
    async with sessionmaker() as db:
        asset = Asset(user_id=user.id, category="primary_home", name="Home")
        db.add(asset)
        await db.flush()
        db.add(Loan(asset_id=asset.id, principal=300000, rate_apr=3.0, term_months=180, origination=date(2021, 3, 10)))
        acct = await db.get(Account, home.id)
        acct.linked_asset_id = asset.id
        acct.current_balance = -198450.00
        extras = {1: 100, 2: 100, 3: 100, 4: 100, 5: 600, 6: 600, 7: 600, 8: 600, 9: 50}
        for m, extra in extras.items():
            db.add(Transaction(account_id=home.id, date_posted=date(2026, m, 25), amount=3150.00, description="PAYMENT"))
            db.add(Transaction(account_id=home.id, date_posted=date(2026, m, 25), amount=extra, description="PRINCIPAL PAYMENT"))
        await db.commit()


async def test_each_payment_is_split_from_the_loan_terms(client, sessionmaker, accounts):
    user, _, home, _ = accounts
    await _sample_loan(sessionmaker, user, home)
    r = (await client.get(_split_url("2026-01-01", "2026-09-30"))).json()["debt"]
    split = r["split"]
    assert split["basis"] == "payments" and split["estimated"] is False and split["rate"] == 3.0
    assert r["paid"] == 31200.00
    assert round(split["principal"]) == 16813 and round(split["interest"]) == 4683 and round(split["other"]) == 9704
    assert split["extra"] == 2850


async def test_a_payment_the_lender_posts_as_two_credits_counts_once(client, sessionmaker, accounts):
    user, checking, home, _ = accounts
    await _add(
        sessionmaker,
        Transaction(account_id=checking.id, date_posted=date(2026, 9, 25), amount=-3200.00,
                    description="EXAMPLE BANK MTG PMT"),
        Transaction(account_id=home.id, date_posted=date(2026, 9, 25), amount=3150.00, description="PAYMENT"),
        Transaction(account_id=home.id, date_posted=date(2026, 9, 25), amount=50, description="PRINCIPAL PAYMENT"),
    )
    r = (await client.get("/api/transactions/breakdown?account_type_group=mortgage")).json()
    assert r["debt"]["paid"] == 3200.00 and r["debt"]["matched_payments"] == 1

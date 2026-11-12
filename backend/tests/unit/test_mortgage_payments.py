"""Mortgage payments split one by one, with a sample loan: $300,000 at 3%
over 180 months (P&I $2,071.74), $198,450.00 owed after the September 2026
payment, $3,150.00 paid each month, and extra principal of $100 in January
to April, $600 in May to August and $50 in September."""
from datetime import date

import pytest

from app.modules.portfolio.mortgage_payments import (
    LoanTerms,
    balance_on,
    infer_from_payments,
    is_principal_only,
    monthly_pi,
    split_credits,
)

pytestmark = pytest.mark.unit

EXTRAS = {1: 100, 2: 100, 3: 100, 4: 100, 5: 600, 6: 600, 7: 600, 8: 600, 9: 50}


def _credits():
    out = []
    for m, extra in EXTRAS.items():
        out.append((m * 10, date(2026, m, 25), 3150.00, "PAYMENT"))
        out.append((m * 10 + 1, date(2026, m, 25), float(extra), "PRINCIPAL PAYMENT"))
    return out


def _terms():
    return LoanTerms(rate_pct=3.0, payment_pi=monthly_pi(300000, 3.0, 180), balance_now=198450.00)


def test_monthly_pi_matches_the_property_page():
    assert round(monthly_pi(300000, 3.0, 180), 2) == 2071.74


def test_each_payment_splits_into_principal_interest_and_escrow():
    parts = split_credits(_credits(), _terms())
    regular = [p for p in parts if not p.extra]
    extra = [p for p in parts if p.extra]
    assert sum(p.amount for p in extra) == 2850
    assert all(p.principal == p.amount and p.interest == 0 for p in extra)
    # Interest falls as the balance falls: about $538 in January, $500 in September.
    assert round(regular[0].interest) == 538 and round(regular[-1].interest) == 500
    assert all(abs(p.escrow - 1078.26) <= 0.011 for p in regular)
    principal = sum(p.principal for p in parts)
    interest = sum(p.interest for p in parts)
    escrow = sum(p.escrow for p in parts)
    assert round(principal) == 16813 and round(interest) == 4683 and round(escrow) == 9704
    assert round(principal + interest + escrow, 2) == round(9 * 3150.00 + 2850, 2)
    assert parts[-1].balance_after == 198450.00


def test_the_balance_walks_back():
    parts = split_credits(_credits(), _terms())
    assert balance_on(parts, date(2026, 10, 24), 198450.00) == 198450.00
    assert balance_on(parts, date(2026, 1, 1), 198450.00) == 215262.72
    jun = balance_on(parts, date(2026, 6, 30), 198450.00)
    may = balance_on(parts, date(2026, 5, 31), 198450.00)
    assert round(may - jun) == 2155  # $1,555 scheduled + $600 extra in June


def test_principal_only_wording_and_amounts():
    assert is_principal_only("PRINCIPAL PAYMENT", 600, 2071.74)
    assert is_principal_only("ADDL PRIN", 100, 2071.74)
    assert not is_principal_only("PAYMENT", 3150.00, 2071.74)
    assert not is_principal_only("PRINCIPAL AND INTEREST", 3150.00, 2071.74)
    assert is_principal_only("ONLINE PAYMENT THANK YOU", 300, 2071.74)


def test_escrow_and_extra_principal_from_the_payments():
    parts = split_credits(_credits(), _terms())
    got = infer_from_payments(parts, today=date(2026, 10, 24))
    assert abs(got.escrow_monthly - 1078.26) <= 0.011
    # April to September: $100 + 4 × $600 + $50 = $2,550 over six months.
    assert got.extra_principal_monthly == round(2550 / 6, 2)


def test_a_payment_under_the_p_and_i_pays_interest_first():
    parts = split_credits([(1, date(2026, 10, 1), 1500.0, "PAYMENT")], _terms())
    p = parts[0]
    assert p.escrow == 0 and round(p.interest + p.principal, 2) == 1500.0
    assert round(p.interest, 2) == round(p.balance_before * 0.03 / 12, 2)


async def test_a_loan_balance_history_falls_with_its_payments(tmp_path):
    """The account's history is walked back through the payments instead of
    sitting flat at today's balance."""
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base
    from app.models.account import Account
    from app.models.asset import Asset, Loan
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.modules.portfolio.account_history import account_balance_series

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'h.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        user = User(email="h@example.com", hashed_password="x")
        db.add(user)
        await db.flush()
        asset = Asset(user_id=user.id, category="primary_home", name="Home")
        db.add(asset)
        await db.flush()
        db.add(Loan(asset_id=asset.id, principal=300000, rate_apr=3.0, term_months=180, origination=date(2021, 3, 10)))
        home = Account(user_id=user.id, display_name="MORTGAGE LOAN", account_type="mortgage",
                       current_balance=-198450.00, linked_asset_id=asset.id, balance_as_of=date(2026, 10, 24))
        db.add(home)
        await db.flush()
        for tid, day, amount, desc in _credits():
            db.add(Transaction(account_id=home.id, date_posted=day, amount=amount, description=desc))
        await db.commit()
        series = (await account_balance_series(db, user.id, date(2026, 1, 1), date(2026, 10, 24), home.id))[home.id]
        by_day = {p["date"]: p["balance"] for p in series}
    await engine.dispose()
    assert by_day["2026-01-01"] == 215262.72
    assert by_day["2026-10-24"] == 198450.00
    assert by_day["2026-06-30"] < by_day["2026-05-31"]


async def test_a_sync_fills_escrow_and_extra_principal_and_keeps_the_past(tmp_path):
    """The loan details read escrow and extra principal from the payments;
    the schedule keeps the months before today; a typed value wins."""
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    import app.models  # noqa: F401
    from app.core.database import Base
    from app.models.account import Account
    from app.models.asset import Asset, Loan, PaymentSchedule
    from app.models.transaction import Transaction
    from app.models.user import User
    from app.modules.portfolio.linked_loans import sync_linked_loan

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 's.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        user = User(email="s@example.com", hashed_password="x")
        db.add(user)
        await db.flush()
        asset = Asset(user_id=user.id, category="primary_home", name="Home")
        db.add(asset)
        await db.flush()
        loan = Loan(asset_id=asset.id, principal=300000, rate_apr=3.0, term_months=180, origination=date(2021, 3, 10),
                    extra_principal_monthly=0, insurance_monthly=0, property_tax_monthly=0)
        db.add(loan)
        home = Account(user_id=user.id, display_name="MORTGAGE LOAN", account_type="mortgage",
                       current_balance=-198450.00, linked_asset_id=asset.id)
        db.add(home)
        await db.flush()
        for tid, day, amount, desc in _credits():
            db.add(Transaction(account_id=home.id, date_posted=day, amount=amount, description=desc))
        await db.commit()

        assert await sync_linked_loan(db, home) is True
        await db.commit()
        assert abs(float(loan.escrow_monthly) - 1078.26) <= 0.011 and loan.escrow_source == "payments"
        # The six whole months before today, whatever today is; with the
        # fixture's payments in January to September it is at most $425.
        assert loan.extra_principal_source == "payments" and float(loan.extra_principal_monthly) <= 425
        rows = (await db.scalars(
            select(PaymentSchedule).where(PaymentSchedule.loan_id == loan.id).order_by(PaymentSchedule.month_number)
        )).all()
        assert rows[0].payment_date == date(2021, 4, 10) and rows[0].month_number == 1
        assert [r.month_number for r in rows] == list(range(1, len(rows) + 1))
        assert all(abs(float(r.escrow) - 1078.26) <= 0.011 for r in rows)

        # A value the user typed is theirs.
        loan.extra_principal_source = "user"
        loan.extra_principal_monthly = 0
        await db.commit()
        await sync_linked_loan(db, home)
        assert float(loan.extra_principal_monthly) == 0
    await engine.dispose()

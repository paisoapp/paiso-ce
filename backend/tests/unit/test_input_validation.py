"""Input accuracy, US phone numbers, merchant logos, and the
transactions breakdown."""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

import app.models  # noqa: F401
from app.core.database import Base
from app.core.validation import (
    MIN_ACCOUNT_HOLDER_AGE,
    check_birth_date,
    check_past_date,
    normalize_us_phone,
)
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.user import User

pytestmark = pytest.mark.unit

TODAY = date.today()


def _years_ago(n: int) -> date:
    return TODAY.replace(year=TODAY.year - n) if not (TODAY.month == 2 and TODAY.day == 29) \
        else TODAY.replace(year=TODAY.year - n, day=28)


# ── Dates of birth ──────────────────────────────────────────────────────────

def test_the_reported_bug_year_one_is_rejected():
    """sign-up accepted a date of birth of 01/01/0001."""
    from app.api.auth import ProfileUpdateIn

    with pytest.raises(ValidationError) as exc:
        ProfileUpdateIn(dob="0001-01-01")
    assert "within the last 120 years" in str(exc.value)


def test_a_future_birth_date_is_rejected():
    with pytest.raises(ValueError, match="future"):
        check_birth_date(TODAY + timedelta(days=1))


def test_the_account_holder_must_be_an_adult():
    from app.api.auth import ProfileUpdateIn

    with pytest.raises(ValidationError, match=f"at least {MIN_ACCOUNT_HOLDER_AGE}"):
        ProfileUpdateIn(dob=_years_ago(MIN_ACCOUNT_HOLDER_AGE - 1).isoformat())
    assert ProfileUpdateIn(dob=_years_ago(MIN_ACCOUNT_HOLDER_AGE).isoformat()).dob is not None


# ── Other accuracy rules ────────────────────────────────────────────────────

def test_a_trade_cannot_be_dated_in_the_future():
    from app.api.holdings import TradeCreate

    with pytest.raises(ValidationError, match="future"):
        TradeCreate(trade_date=TODAY + timedelta(days=30), action="buy", shares=1, price_per_share=10)
    with pytest.raises(ValidationError):
        TradeCreate(trade_date=TODAY, action="buy", shares=-5, price_per_share=10)


def test_past_date_allows_one_day_of_timezone_grace():
    assert check_past_date(TODAY + timedelta(days=1))
    with pytest.raises(ValueError):
        check_past_date(date(1850, 1, 1))


def test_ownership_share_and_loan_rate_are_bounded():
    from app.api.assets import AssetCreate, LoanIn

    with pytest.raises(ValidationError):
        AssetCreate(category="primary_home", name="Home", ownership_pct=250)
    with pytest.raises(ValidationError):
        LoanIn(principal=300000, rate_apr=650, term_months=360, origination=TODAY)
    assert LoanIn(principal=300000, rate_apr=6.5, term_months=360, origination=TODAY).rate_apr == 6.5


def test_an_expense_ratio_typed_as_a_fraction_of_a_percent_is_fine_but_100x_is_not():
    from app.api.holdings import SecurityIn

    assert SecurityIn(name="VOO", expense_ratio=0.03).expense_ratio == 0.03
    with pytest.raises(ValidationError):
        SecurityIn(name="VOO", expense_ratio=30)


def test_money_rejects_absurd_and_non_finite_amounts():
    from app.api.transactions import TransactionCreate

    base = dict(account_id=1, date_posted=TODAY, description="x")
    with pytest.raises(ValidationError, match="too large"):
        TransactionCreate(**base, amount=5e15)
    with pytest.raises(ValidationError):
        TransactionCreate(**base, amount=float("nan"))
    assert TransactionCreate(**base, amount=-42.5).amount == -42.5


def test_a_balance_is_kept_to_the_cent():
    """-5000.129 was stored as typed."""
    from app.api.accounts import AccountUpdate

    assert AccountUpdate(current_balance=-5000.129).current_balance == -5000.13
    assert AccountUpdate(current_balance=None).current_balance is None


# ── Phone numbers ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw", ["(415) 555-2671", "415.555.2671", "4155552671", "+1 415 555 2671", "1-415-555-2671"])
def test_us_numbers_in_any_format_normalise_to_e164(raw):
    assert normalize_us_phone(raw) == "+14155552671"


@pytest.mark.parametrize("raw", ["555-1234", "(123) 456-7890", "+44 20 7946 0958", "12345", "call me"])
def test_numbers_that_are_not_real_us_numbers_are_rejected(raw):
    with pytest.raises(ValueError, match="valid US phone"):
        normalize_us_phone(raw)


def test_blank_phone_clears_the_field():
    from app.api.auth import ProfileUpdateIn

    assert normalize_us_phone("  ") is None
    assert ProfileUpdateIn(phone="(415) 555-2671").phone == "+14155552671"


# ── Merchant logos ──────────────────────────────────────────────────────────

# ── Transactions breakdown ───────────────────────────────────────────

@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield session
    finally:
        await engine.dispose()


async def _seed(db):
    u = User(email="bd@example.com", hashed_password="x", token_family="f")
    db.add(u)
    await db.flush()
    chk = Account(user_id=u.id, display_name="Checking", account_type="checking")
    card_a = Account(user_id=u.id, display_name="Visa", account_type="credit_card")
    card_b = Account(user_id=u.id, display_name="Amex", account_type="credit_card")
    db.add_all([chk, card_a, card_b])
    await db.flush()
    rows = [
        (chk, "3000"), (chk, "-1200"),
        (card_a, "-50"), (card_a, "-25"), (card_a, "200"),
        (card_b, "-10"),
    ]
    db.add_all([
        Transaction(account_id=a.id, date_posted=TODAY, description="t", amount=Decimal(v))
        for a, v in rows
    ])
    await db.commit()
    return u, [chk.id, card_a.id, card_b.id], card_a


def _args(**over):
    base = dict(
        group_by="type_group", account_id=None, account_type_group=None, category_id=None,
        date_from=None, date_to=None, search=None, uncategorized=False,
        exclude_transfers=False, only_transfers=False, only_pending=False,
        exclude_pending=False, amount_sign=None,
    )
    base.update(over)
    return base


async def test_breakdown_by_account_type(db):
    from app.api.transactions import transaction_breakdown

    u, ids, _ = await _seed(db)
    out = await transaction_breakdown(**_args(), db=db, user=u, user_account_ids=ids)
    by = {g["key"]: g for g in out["groups"]}
    assert out["total_count"] == 6
    assert by["credit_cards"]["count"] == 4
    assert by["credit_cards"]["outflow"] == pytest.approx(85.0)
    assert by["credit_cards"]["inflow"] == pytest.approx(200.0)
    assert by["cash"]["label"] == "Cash & Bank"
    assert by["cash"]["net"] == pytest.approx(1800.0)


async def test_breakdown_by_account_honours_the_tab_filter(db):
    from app.api.transactions import transaction_breakdown

    u, ids, visa = await _seed(db)
    out = await transaction_breakdown(
        **_args(group_by="account", account_type_group="credit_cards"),
        db=db, user=u, user_account_ids=ids,
    )
    assert {g["label"] for g in out["groups"]} == {"Visa", "Amex"}
    assert out["total_count"] == 4
    assert next(g for g in out["groups"] if g["key"] == str(visa.id))["count"] == 3

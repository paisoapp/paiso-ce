"""What an account held on a past day.

An account's balance is overwritten on every update and its transactions
carry no running balance, so the trend drew it flat at today's figure. Two
things fix that: the balance is now kept per day as it is observed, and for
days before the first one kept it is worked back from the transactions.
"""
from datetime import date, timedelta

import pytest
from sqlalchemy import select

from app.models.account import Account
from app.models.account_balance import AccountBalanceSnapshot
from app.models.transaction import Transaction
from app.modules.portfolio.balance_history import AmountsByDate, balance_before, record_balance
from app.modules.portfolio.net_worth_history import reconstruct_net_worth
from tests.unit.test_portfolio_valuation import _user, db  # noqa: F401

pytestmark = pytest.mark.unit

TODAY = date.today()


def _ago(days: int) -> date:
    return TODAY - timedelta(days=days)


def test_amounts_are_summed_after_one_day_through_another():
    amounts = AmountsByDate([(_ago(1), -30.0), (_ago(5), 100.0), (_ago(3), -20.0)])
    assert amounts.between(_ago(4), TODAY) == pytest.approx(-50.0)
    assert amounts.between(_ago(5), _ago(3)) == pytest.approx(-20.0)  # the 5th itself is excluded
    assert amounts.between(_ago(9), TODAY) == pytest.approx(50.0)
    assert amounts.between(TODAY, TODAY) == 0.0


def test_an_earlier_balance_is_the_later_one_less_what_posted_since():
    # 1,000 today, after 200 came in two days ago: 800 before that.
    amounts = AmountsByDate([(_ago(2), 200.0)])
    assert balance_before(TODAY, 1000.0, amounts, _ago(3)) == pytest.approx(800.0)
    assert balance_before(TODAY, 1000.0, amounts, _ago(2)) == pytest.approx(1000.0)


async def _account(db, user, kind, balance):
    acct = Account(user_id=user.id, display_name=kind, account_type=kind,
                   current_balance=balance, balance_as_of=TODAY)
    db.add(acct)
    await db.flush()
    return acct


def _txn(acct, days_ago, amount, **kw):
    return Transaction(account_id=acct.id, date_posted=_ago(days_ago), amount=amount,
                       description="t", **kw)


async def _point(db, user, days_ago):
    return (await reconstruct_net_worth(db, user.id, _ago(days_ago), _ago(days_ago)))[-1]


async def test_a_second_balance_on_one_day_replaces_the_first(db):
    u = await _user(db)
    acct = await _account(db, u, "checking", 500)
    await record_balance(db, acct.id, 500)
    await record_balance(db, acct.id, 650)
    await db.commit()
    rows = (await db.scalars(select(AccountBalanceSnapshot))).all()
    assert [(r.as_of, float(r.balance)) for r in rows] == [(TODAY, 650.0)]


async def test_a_kept_balance_is_what_the_trend_draws_for_that_day(db):
    u = await _user(db)
    acct = await _account(db, u, "checking", 900)
    await record_balance(db, acct.id, 400, _ago(10))
    await record_balance(db, acct.id, 900, TODAY)
    await db.commit()

    assert (await _point(db, u, 10))["cash"] == pytest.approx(400.0)
    assert (await _point(db, u, 4))["cash"] == pytest.approx(400.0)   # carried until the next one
    assert (await _point(db, u, 0))["cash"] == pytest.approx(900.0)


async def test_cash_before_the_first_kept_balance_is_worked_back(db):
    """No balance was ever kept. The line used to be flat at 1,000."""
    u = await _user(db)
    acct = await _account(db, u, "checking", 1000)
    db.add_all([_txn(acct, 2, 300.0), _txn(acct, 6, -50.0)])
    await db.commit()

    assert (await _point(db, u, 0))["cash"] == pytest.approx(1000.0)
    assert (await _point(db, u, 3))["cash"] == pytest.approx(700.0)    # before the 300 came in
    assert (await _point(db, u, 8))["cash"] == pytest.approx(750.0)    # and before the 50 went out


async def test_a_card_is_worked_back_as_an_amount_owed(db):
    """Money in pays a card down, so going back past a payment the debt is
    larger, and going back past a purchase it is smaller."""
    u = await _user(db)
    card = await _account(db, u, "credit_card", 500)
    db.add_all([_txn(card, 2, -120.0), _txn(card, 5, 400.0)])   # a purchase, then earlier a payment
    await db.commit()

    assert (await _point(db, u, 0))["credit_cards"] == pytest.approx(500.0)
    assert (await _point(db, u, 3))["credit_cards"] == pytest.approx(380.0)
    assert (await _point(db, u, 7))["credit_cards"] == pytest.approx(780.0)


async def test_a_pending_transaction_is_not_counted(db):
    u = await _user(db)
    acct = await _account(db, u, "checking", 1000)
    db.add(_txn(acct, 2, 300.0, pending=True))
    await db.commit()
    assert (await _point(db, u, 5))["cash"] == pytest.approx(1000.0)


async def test_a_loan_is_not_worked_back(db):
    """A loan payment is part interest, so its transactions do not add up to
    the balance. It stays at the figure on record."""
    u = await _user(db)
    loan = await _account(db, u, "loan", 9000)
    db.add(_txn(loan, 2, 400.0))
    await db.commit()
    assert (await _point(db, u, 5))["loans"] == pytest.approx(9000.0)


# ── One account at a time: the card's sparkline and the drawer's chart ───────

async def _series(db, user, days_back, account_id=None):
    from app.modules.portfolio.account_history import account_balance_series

    out = await account_balance_series(db, user.id, _ago(days_back), TODAY, account_id)
    return {aid: {p["date"]: p["balance"] for p in pts} for aid, pts in out.items()}


async def test_each_account_gets_its_own_line(db):
    u = await _user(db)
    cash = await _account(db, u, "checking", 1000)
    card = await _account(db, u, "credit_card", 500)
    db.add_all([_txn(cash, 2, 300.0), _txn(card, 2, -120.0)])
    await db.commit()

    lines = await _series(db, u, 5)
    assert lines[cash.id][TODAY.isoformat()] == pytest.approx(1000.0)
    assert lines[cash.id][_ago(4).isoformat()] == pytest.approx(700.0)
    assert lines[card.id][_ago(4).isoformat()] == pytest.approx(380.0)   # owed, so positive
    assert len(lines[cash.id]) == 6                                       # one point a day


async def test_one_account_can_be_asked_for_alone(db):
    u = await _user(db)
    cash = await _account(db, u, "checking", 1000)
    await _account(db, u, "savings", 50)
    await db.commit()
    assert set(await _series(db, u, 3, cash.id)) == {cash.id}


async def test_another_users_account_is_not_returned(db):
    from app.models.user import User

    u = await _user(db)
    other = User(email="o@example.com", hashed_password="x", token_family="g")
    db.add(other)
    await db.flush()
    theirs = await _account(db, other, "checking", 77)
    await db.commit()
    assert await _series(db, u, 3, theirs.id) == {}


async def test_a_long_range_is_weekly_and_still_ends_today(db):
    u = await _user(db)
    cash = await _account(db, u, "checking", 10)
    await db.commit()
    line = (await _series(db, u, 800))[cash.id]
    assert TODAY.isoformat() in line
    assert len(line) < 130


async def test_an_account_with_no_balance_has_no_line(db):
    u = await _user(db)
    await _account(db, u, "checking", None)
    await db.commit()
    assert await _series(db, u, 3) == {}

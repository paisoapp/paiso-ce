"""A hand-kept mortgage made with its property shows what is owed."""
from datetime import date
from types import SimpleNamespace

import pytest

from app.api.accounts import _balance_out

pytestmark = pytest.mark.unit


def test_a_mortgage_without_its_own_balance_shows_the_loan():
    acct = SimpleNamespace(current_balance=None, balance_as_of=None, _loan_balance=250000.00)
    out = _balance_out(acct)
    assert out == {"current_balance": 250000.00, "balance_as_of": date.today().isoformat()}


def test_an_account_balance_wins_over_the_loan():
    acct = SimpleNamespace(current_balance=1000, balance_as_of=date(2026, 10, 1), _loan_balance=5)
    assert _balance_out(acct)["current_balance"] == 1000.0


def test_no_balance_and_no_loan_stays_empty():
    acct = SimpleNamespace(current_balance=None, balance_as_of=None)
    assert _balance_out(acct) == {"current_balance": None, "balance_as_of": None}

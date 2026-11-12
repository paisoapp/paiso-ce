"""Regression tests for amortization payment-date generation.

Pure-function tests against ``_amortize`` (no DB, no server). The focus is the
day-of-month edge case: a loan originating on the 29th–31st must not raise
``ValueError: day is out of range for month`` when the schedule lands on a
shorter month (e.g. a Jan-31 origination projecting into February).
"""
import calendar
from datetime import date

import pytest

from app.api.assets import LoanIn, _amortize

pytestmark = pytest.mark.unit


def _loan(origination: date) -> LoanIn:
    return LoanIn(
        principal=300_000,
        rate_apr=6.0,
        term_months=24,
        origination=origination,
    )


@pytest.mark.parametrize("start_day", [29, 30, 31])
def test_amortize_handles_month_end_origination(start_day: int):
    """A start day past the 28th must clamp, not crash, in short months."""
    schedule = _amortize(_loan(date(2026, 1, start_day)))

    assert len(schedule) == 24
    for row in schedule:
        d = row["payment_date"]
        # Every generated date is valid and clamped to its month's last day.
        last_day = calendar.monthrange(d.year, d.month)[1]
        assert d.day == min(start_day, last_day)


def test_amortize_jan31_february_is_clamped():
    """The exact case reported: Jan-31 -> Feb must become Feb 28/29."""
    schedule = _amortize(_loan(date(2026, 1, 31)))
    feb = next(r["payment_date"] for r in schedule if r["payment_date"].month == 2)
    assert feb == date(2026, 2, 28)  # 2026 is not a leap year

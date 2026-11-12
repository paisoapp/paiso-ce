"""Unit tests for the day-change session baseline (app.api.holdings._session_delta).

Regression cover for the "$0.00 today" bug: the baseline used to be pinned to
the most recent close *before today's calendar date*, which collapses to zero
whenever the market isn't trading — all weekend, on holidays, and every morning
before the first live quote landed. [issues 5 + 9]

Pure function, no DB and no network.
"""
from datetime import timedelta

import pytest

from app.api.holdings import _session_delta
from app.modules.investments.refresh import market_today

pytestmark = pytest.mark.unit

# The market's date, which is what _session_delta compares against.
TODAY = market_today()
# Sessions, most recent first. Values mirror real AMZN closes from the bug report.
FRI = (TODAY - timedelta(days=1), 247.23)
THU = (TODAY - timedelta(days=2), 249.89)


def test_market_closed_reports_last_session_move():
    """The headline case: price is Friday's close, read back on Saturday.

    Baseline must step back to Thursday, not compare Friday against itself.
    """
    change, pct, session = _session_delta(FRI[1], [FRI, THU])

    assert change == pytest.approx(-2.66, abs=0.01)
    assert pct == pytest.approx(-1.064, abs=0.01)
    assert session == FRI[0], "change is attributed to Friday's session, not today"


def test_live_price_compares_against_last_close():
    """Mid-session: a live tick is measured against the last completed close."""
    change, pct, session = _session_delta(250.00, [FRI, THU])

    assert change == pytest.approx(250.00 - 247.23)
    assert pct == pytest.approx((250.00 - 247.23) / 247.23 * 100)
    assert session == TODAY


def test_todays_close_already_stored_steps_back():
    """Once today's close is persisted, it's the session — baseline is yesterday."""
    today_row = (TODAY, 250.00)
    change, _pct, session = _session_delta(250.00, [today_row, FRI])

    assert change == pytest.approx(250.00 - 247.23)
    assert session == TODAY


def test_pre_open_does_not_report_zero():
    """The #9 symptom: before the first live quote, price == last close.

    Must report the previous session's move rather than a flat $0.00.
    """
    change, _pct, _session = _session_delta(FRI[1], [FRI, THU])

    assert change != 0.0


def test_float_noise_still_counts_as_the_same_close():
    """A price a hair off the stored close is that close, not a live tick."""
    change, _pct, session = _session_delta(FRI[1] + 1e-9, [FRI, THU])

    assert change == pytest.approx(-2.66, abs=0.01)
    assert session == FRI[0]


@pytest.mark.parametrize(
    "price, closes",
    [
        (247.23, []),           # no history at all
        (247.23, [FRI]),        # only one session — can't derive a baseline
        (0.0, [FRI, THU]),      # no usable price
        (247.23, [FRI, (THU[0], 0.0)]),  # zero baseline would divide by zero
    ],
)
def test_insufficient_data_defers_to_the_quote(price, closes):
    """Returning None tells the caller to fall back to yfinance's own delta."""
    change, _pct, _session = _session_delta(price, closes)

    assert change is None


def test_stray_next_day_copy_is_why_rows_read_zero():
    """an evening refresh wrote today's close again under tomorrow's UTC
    date. Fed that pair, the delta is exactly zero, which is what the page
    showed; the holdings endpoint now drops such rows before calling this."""
    stray = (TODAY + timedelta(days=1), FRI[1])
    change, _pct, _session = _session_delta(FRI[1], [stray, FRI])
    assert change == 0.0

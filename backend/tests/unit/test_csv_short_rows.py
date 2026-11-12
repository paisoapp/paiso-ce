"""A mapped CSV with short or long rows imports instead of returning a 500.

A brokerage positions export ends with one-cell footnote lines. csv.DictReader
fills their missing cells with None, and `_parse_row` called .strip() on them.
"""
import pytest

from app.modules.accounts.csv_parser import parse_csv_preview, validate_rows

pytestmark = pytest.mark.unit

FILE = (
    b'"Description","Pricing Date","Value","Acct Type"\n'
    b'"NVIDIA CORP","10/30/2026 08:00:00","12,000.00","Cash"\n'
    b'"VANGUARD S&P 500 ETF","10/30/2026 08:00:00","8,000.00","Cash","extra cell"\n'
    b'"FOOTNOTES"\n'
)
COLUMNS = {"date_posted": "Pricing Date", "description": "Description", "amount": "Value"}


def test_short_and_long_rows_are_reported_not_raised():
    result = validate_rows(FILE, COLUMNS, account_id=1)

    assert [t["description"] for t in result["valid"]] == ["NVIDIA CORP", "VANGUARD S&P 500 ETF"]
    [footnote] = result["invalid"]
    assert footnote["errors"]["date_posted"] == "Date is empty"
    assert None not in footnote["raw"]


def test_preview_rows_have_only_string_cells():
    rows = parse_csv_preview(FILE)["sample_rows"]

    assert all(None not in row and all(isinstance(v, str) for v in row.values()) for row in rows)

"""The OFX/QFX parser against the shapes real exports take.

The fixtures are synthetic (no real account, name or number), written to
cover the ways institutions differ: leaf tags closed or left open, CRLF or LF,
OFX 1.x SGML or 2.x XML, cp1252 names, one account per file or several.
"""
from datetime import date
from pathlib import Path

import pytest

from app.modules.aggregator.ofx_parser import (
    decode_ofx,
    looks_like_ofx,
    parse_ofx_amount,
    parse_ofx_response,
    parse_ofx_statements,
)

FIXTURES = Path(__file__).parent / "fixtures"


def _statements(name: str):
    return parse_ofx_statements(decode_ofx((FIXTURES / name).read_bytes()))


def test_checking_with_closed_leaf_tags():
    """<NAME>Shop</NAME> inside SGML: the closing tag used to close the
    transaction around it and scatter the fields that followed."""
    (stmt,) = _statements("synthetic_checking_sgml.qfx")
    assert stmt.kind == "bank"
    assert stmt.account.account_type == "CHECKING"
    assert stmt.account.account_number.endswith("2333")
    assert len(stmt.transactions) == 7 and stmt.unreadable == 0
    assert stmt.ledger_balance.amount == 4310.81

    by_id = {t.fitid: t for t in stmt.transactions}
    rent = by_id["SYN2026090300002"]
    assert rent.name == "RENT & UTILITIES LLC"  # entity unescaped
    assert rent.amount == -1250.00 and rent.date_posted == date(2026, 9, 3)
    assert by_id["SYN2026090200001"].memo == "PURCHASE 09/01"
    # A thousands separator in the amount.
    assert by_id["SYN2026092500006"].amount == -1089.99
    # 23:30 at -5 is the 20th where the customer is. It stays the 20th.
    assert by_id["SYN2026092000005"].date_posted == date(2026, 9, 20)


def test_card_with_open_leaf_tags_and_missing_pieces():
    (stmt,) = _statements("synthetic_card_sgml.qfx")
    assert stmt.kind == "card" and stmt.account.account_type == "CREDITCARD"
    assert stmt.ledger_balance.amount == -946.04  # negative: money owed

    names = [t.name for t in stmt.transactions]
    assert "CAFÉ LUNA" in names  # cp1252, per the file's CHARSET header
    # An empty <MEMO> must not swallow the fields after it.
    assert [t.amount for t in stmt.transactions] == [-23.75, -412.30, 500.00, -9.99]

    # No FITID: kept, with an id that is the same on every parse.
    streaming = next(t for t in stmt.transactions if t.name == "STREAMING SERVICE")
    assert streaming.fitid.startswith("nofitid-")
    (again,) = _statements("synthetic_card_sgml.qfx")
    assert streaming.fitid == next(
        t.fitid for t in again.transactions if t.name == "STREAMING SERVICE")

    # No date: not imported as "today", and counted so the person is told.
    assert "ROW WITH NO DATE" not in names
    assert stmt.unreadable == 1


def test_a_card_sent_as_a_bank_statement_is_still_a_card():
    """Some issuers put a card in a bank statement with ACCTTYPE CREDITLINE.
    Read as a bank account, the import warned that a card statement did not
    belong in a card account."""
    (stmt,) = _statements("synthetic_card_as_creditline.ofx")
    assert stmt.kind == "card"
    assert stmt.account.account_type == "CREDITLINE"
    assert len(stmt.transactions) == 3
    assert stmt.ledger_balance.amount == -312.45


def test_brokerage_statement():
    (stmt,) = _statements("synthetic_brokerage_sgml.ofx")
    assert stmt.kind == "investment"
    assert stmt.account.broker_id == "syntheticbroker.example"
    assert stmt.trade_count == 2
    assert len(stmt.holdings) == 2
    assert {t.fitid for t in stmt.transactions} == {
        "INV-BUY-1", "INV-SELL-1", "INV-DIV-1", "INV-REINV-1", "INV-CASH-1"}

    dividend, reinvest = sorted(stmt.inv_income, key=lambda i: i.is_reinvest)
    assert (dividend.uniqueid, dividend.total, dividend.income_type) == ("VTI", 18.44, "DIV")
    assert reinvest.is_reinvest and reinvest.units == 0.096 and reinvest.unit_price == 130.21


def test_xml_file_with_two_accounts_keeps_them_apart():
    checking, savings = _statements("synthetic_two_accounts_xml.ofx")
    assert (checking.account.account_type, len(checking.transactions)) == ("CHECKING", 3)
    assert (savings.account.account_type, len(savings.transactions)) == ("SAVINGS", 2)
    assert checking.ledger_balance.amount == 5045.56
    assert savings.ledger_balance.amount == 12507.15

    by_id = {t.fitid: t for t in checking.transactions}
    assert by_id["X-CHK-1"].name == "CITY WATER & SEWER"
    assert by_id["X-CHK-2"].name == "EMPLOYER INC"  # from a PAYEE aggregate
    assert by_id["X-CHK-3"].amount == -12.34  # decimal comma

    # The flattened view still carries everything.
    flat = parse_ofx_response(decode_ofx((FIXTURES / "synthetic_two_accounts_xml.ofx").read_bytes()))
    assert len(flat.transactions) == 5 and len(flat.accounts) == 2


def test_a_truncated_file_gives_what_it_has():
    (stmt,) = _statements("synthetic_truncated.qfx")
    assert [t.fitid for t in stmt.transactions] == ["SYN2026090200001", "SYN2026090300002"]
    assert stmt.ledger_balance is None


def test_a_file_that_is_not_ofx():
    content = (FIXTURES / "synthetic_not_ofx.qfx").read_bytes()
    assert looks_like_ofx(content) is False
    assert parse_ofx_statements(decode_ofx(content)) == []
    assert looks_like_ofx((FIXTURES / "synthetic_checking_sgml.qfx").read_bytes()) is True
    assert looks_like_ofx((FIXTURES / "synthetic_two_accounts_xml.ofx").read_bytes()) is True


@pytest.mark.parametrize("raw,expected", [
    ("-54.12", -54.12),
    ("+5.00", 5.0),
    ("1,234.56", 1234.56),
    ("-1,089.99", -1089.99),
    ("1.234,56", 1234.56),
    ("-12,34", -12.34),
    ("1,234,567", 1234567.0),
    (" 42 ", 42.0),
])
def test_amounts(raw, expected):
    assert parse_ofx_amount(raw) == expected


def test_an_empty_amount_is_an_error_not_zero():
    with pytest.raises(ValueError):
        parse_ofx_amount("  ")

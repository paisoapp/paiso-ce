"""Tests for the OFX SGML/XML parser."""
from pathlib import Path

import pytest

from app.modules.aggregator.ofx_parser import (
    OFXResult,
    parse_ofx_response,
)

FIXTURES = Path(__file__).parent / "fixtures"


def load_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# SGML parsing
# ---------------------------------------------------------------------------

class TestSGMLParsing:
    def test_parses_vanguard_ofx(self):
        raw = load_fixture("vanguard_sample.ofx")
        result = parse_ofx_response(raw)

        assert isinstance(result, OFXResult)
        # Should find the investment account
        assert len(result.accounts) >= 1
        acct = result.accounts[0]
        assert acct.account_number == "8675309"
        assert acct.account_type == "INVESTMENT"

    def test_parses_transactions(self):
        raw = load_fixture("vanguard_sample.ofx")
        result = parse_ofx_response(raw)

        # Should have the INVBANKTRAN transaction at minimum
        fitids = [t.fitid for t in result.transactions]
        assert "VG-20231215-003" in fitids

        # Find the dividend transaction
        dividend = next(t for t in result.transactions if t.fitid == "VG-20231215-003")
        assert dividend.amount == 1500.00
        assert dividend.date_posted.year == 2023
        assert dividend.date_posted.month == 12

    def test_parses_holdings(self):
        raw = load_fixture("vanguard_sample.ofx")
        result = parse_ofx_response(raw)

        assert len(result.holdings) >= 1
        holding = result.holdings[0]
        # The SECID is a CUSIP and the file has no SECLIST, so no ticker.
        assert (holding.uniqueid, holding.uniqueid_type, holding.ticker) == ("922908769", "CUSIP", "")
        assert holding.kind == "POSMF"
        assert holding.units == pytest.approx(125.432)
        assert holding.market_value == pytest.approx(14102.85)

    def test_sgml_banking_statement(self):
        """Test parsing a simple bank account OFX SGML response."""
        raw = """OFXHEADER:100
DATA:OFXSGML
VERSION:151
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20240115120000
<LANGUAGE>ENG
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1001
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>121000358
<ACCTID>1234567890
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20240101
<DTEND>20240115
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240105120000
<TRNAMT>-50.00
<FITID>CHK-001
<NAME>AMAZON
<MEMO>Online purchase
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240110120000
<TRNAMT>2000.00
<FITID>CHK-002
<NAME>EMPLOYER PAYROLL
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5000.00
<DTASOF>20240115
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
"""
        result = parse_ofx_response(raw)

        assert len(result.accounts) >= 1
        acct = result.accounts[0]
        assert acct.account_number == "1234567890"
        assert acct.account_type == "CHECKING"

        fitids = [t.fitid for t in result.transactions]
        assert "CHK-001" in fitids
        assert "CHK-002" in fitids

        debit = next(t for t in result.transactions if t.fitid == "CHK-001")
        assert debit.amount == -50.0

        credit = next(t for t in result.transactions if t.fitid == "CHK-002")
        assert credit.amount == 2000.0

        assert len(result.balances) >= 1
        assert result.balances[0].amount == pytest.approx(5000.0)


# ---------------------------------------------------------------------------
# XML parsing
# ---------------------------------------------------------------------------

class TestXMLParsing:
    def test_parses_xml_ofx(self):
        """Test parsing OFX 2.x XML format."""
        raw = """<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1>
    <SONRS>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <DTSERVER>20240115120000</DTSERVER>
      <LANGUAGE>ENG</LANGUAGE>
    </SONRS>
  </SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>1001</TRNUID>
      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM>
          <BANKID>021000021</BANKID>
          <ACCTID>9876543210</ACCTID>
          <ACCTTYPE>SAVINGS</ACCTTYPE>
        </BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20240101</DTSTART>
          <DTEND>20240115</DTEND>
          <STMTTRN>
            <TRNTYPE>CREDIT</TRNTYPE>
            <DTPOSTED>20240108000000</DTPOSTED>
            <TRNAMT>500.00</TRNAMT>
            <FITID>SAV-XML-001</FITID>
            <NAME>Interest</NAME>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL>
          <BALAMT>12500.00</BALAMT>
          <DTASOF>20240115</DTASOF>
        </LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>"""
        result = parse_ofx_response(raw)

        assert len(result.accounts) >= 1
        acct = result.accounts[0]
        assert acct.account_number == "9876543210"
        assert acct.account_type == "SAVINGS"

        assert len(result.transactions) == 1
        txn = result.transactions[0]
        assert txn.fitid == "SAV-XML-001"
        assert txn.amount == pytest.approx(500.0)

        assert len(result.balances) >= 1
        assert result.balances[0].amount == pytest.approx(12500.0)


# ---------------------------------------------------------------------------
# Malformed OFX — should return partial data, never raise
# ---------------------------------------------------------------------------

class TestMalformedOFX:
    def test_empty_string_returns_empty_result(self):
        result = parse_ofx_response("")
        assert isinstance(result, OFXResult)
        assert result.transactions == []
        assert result.accounts == []

    def test_garbage_input_returns_empty_result(self):
        result = parse_ofx_response("not ofx data at all @@@ ###")
        assert isinstance(result, OFXResult)

    def test_partial_ofx_returns_partial_data(self):
        """Truncated OFX should return whatever was successfully parsed."""
        raw = """OFXHEADER:100
DATA:OFXSGML
VERSION:151
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKACCTFROM>
<ACCTID>PARTIAL123
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240101
<TRNAMT>-25.00
<FITID>PARTIAL-001
<NAME>PARTIAL TXN
"""
        # Should not raise
        result = parse_ofx_response(raw)
        assert isinstance(result, OFXResult)

    def test_missing_fitid_skips_transaction(self):
        """Transactions missing FITID should be skipped."""
        raw = """OFXHEADER:100
DATA:OFXSGML
VERSION:151
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKACCTFROM>
<BANKID>121000358
<ACCTID>111222333
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240101
<TRNAMT>-25.00
<NAME>NO FITID TXN
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240102
<TRNAMT>100.00
<FITID>GOOD-001
<NAME>GOOD TXN
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
"""
        result = parse_ofx_response(raw)
        # Only the transaction with FITID should appear
        assert any(t.fitid == "GOOD-001" for t in result.transactions)
        assert not any(t.fitid == "" for t in result.transactions)


# ---------------------------------------------------------------------------
# Structured investment income (INCOME / REINVEST)
# ---------------------------------------------------------------------------

class TestInvIncomeParsing:
    def test_parses_income_and_reinvest(self):
        raw = load_fixture("vanguard_sample.ofx")
        result = parse_ofx_response(raw)

        assert len(result.inv_income) == 2
        by_fitid = {i.fitid: i for i in result.inv_income}

        div = by_fitid["VG-20231220-004"]
        assert div.income_type == "DIV"
        assert div.is_reinvest is False
        assert div.total == pytest.approx(62.50)
        assert div.uniqueid == "922908769"
        assert div.units == 0.0
        assert div.date_posted.isoformat() == "2023-12-20"

        drip = by_fitid["VG-20231221-005"]
        assert drip.is_reinvest is True
        assert drip.total == pytest.approx(85.20)  # absolute value of -85.20
        assert drip.units == pytest.approx(0.214)
        assert drip.unit_price == pytest.approx(398.13)

    def test_income_rows_still_emit_cash_transactions(self):
        """Backward compat: INCOME/REINVEST still produce generic cash rows."""
        raw = load_fixture("vanguard_sample.ofx")
        result = parse_ofx_response(raw)
        fitids = [t.fitid for t in result.transactions]
        assert "VG-20231220-004" in fitids
        assert "VG-20231221-005" in fitids


def test_the_seclist_names_each_position():
    """Positions and income key on a CUSIP; the ticker and name are only in
    the file's SECLIST."""
    from app.modules.aggregator.ofx_parser import parse_ofx_statements

    (stmt,) = parse_ofx_statements(load_fixture("synthetic_brokerage_seclist.ofx"))
    assert [(h.ticker, h.name, h.units) for h in stmt.holdings] == [
        ("VTI", "SYNTHETIC TOTAL STOCK MARKET ETF", 110.0),
        ("VTSAX", "SYNTHETIC TOTAL STOCK MARKET INDEX FUND", 245.096),
        ("", "SYNTHETIC TARGET RETIREMENT 2050 TRUST", 400.0),
    ]
    assert stmt.holdings[2].uniqueid == "99999TRST"
    assert [(i.uniqueid, i.ticker) for i in stmt.inv_income] == [("922908769", "VTI"), ("VTSAX", "")]
    # Buys, sales and income are inside the account; the transfer is cash.
    assert [(t.name, t.investment) for t in stmt.transactions][-1] == ("ELECTRONIC FUNDS TRANSFER", False)
    assert all(t.investment for t in stmt.transactions[:-1])

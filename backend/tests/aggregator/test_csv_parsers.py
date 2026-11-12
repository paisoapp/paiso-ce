"""Tests for CSV/OFX parsers including auto-detection."""
from pathlib import Path

import pytest

from app.modules.aggregator.csv_parsers import (
    parse_csv_auto_with_institution,
    _content_hash_fitid,
    parse_chase_csv,
    parse_citibank_csv,
    parse_csv_auto,
    parse_ofx_file,
)

FIXTURES = Path(__file__).parent / "fixtures"


class TestChaseCsvParser:
    def test_parses_all_rows(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)
        assert len(txns) == 5

    def test_negative_amounts_preserved(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)

        amazon = next(t for t in txns if "AMAZON" in t.name)
        assert amazon.amount == pytest.approx(-89.99)

    def test_positive_amounts_preserved(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)

        payroll = next(t for t in txns if "PAYROLL" in t.name)
        assert payroll.amount == pytest.approx(3500.00)

    def test_date_parsing(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)

        assert txns[0].date_posted.month == 1
        assert txns[0].date_posted.day == 5
        assert txns[0].date_posted.year == 2024

    def test_fitid_is_hash(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)

        for txn in txns:
            assert len(txn.fitid) == 16
            # All hex
            int(txn.fitid, 16)

    def test_fitids_are_unique(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)
        fitids = [t.fitid for t in txns]
        assert len(fitids) == len(set(fitids))

    def test_memo_captured(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_chase_csv(content)

        starbucks = next(t for t in txns if "STARBUCKS" in t.name)
        assert "Order" in starbucks.memo

    def test_skips_blank_rows(self):
        content = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n\n01/05/2024,01/06/2024,TEST,Shopping,Sale,-10.00,\n"
        txns = parse_chase_csv(content)
        assert len(txns) == 1


class TestCitibankCsvParser:
    def test_parses_all_rows(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)
        assert len(txns) == 5

    def test_debit_becomes_negative(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)

        groceries = next(t for t in txns if "WHOLE FOODS" in t.name)
        assert groceries.amount == pytest.approx(-54.32)

    def test_credit_becomes_positive(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)

        payroll = next(t for t in txns if "PAYROLL" in t.name)
        assert payroll.amount == pytest.approx(2800.00)

    def test_interest_is_positive(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)

        interest = next(t for t in txns if "INTEREST" in t.name)
        assert interest.amount == pytest.approx(12.50)

    def test_fitids_are_unique(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)
        fitids = [t.fitid for t in txns]
        assert len(fitids) == len(set(fitids))

    def test_trntype_set_correctly(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_citibank_csv(content)

        debit = next(t for t in txns if "WHOLE FOODS" in t.name)
        assert debit.trntype == "DEBIT"

        credit = next(t for t in txns if "PAYROLL" in t.name)
        assert credit.trntype == "CREDIT"


class TestDeduplicationHash:
    def test_same_inputs_produce_same_hash(self):
        from datetime import date
        d = date(2024, 1, 5)
        h1 = _content_hash_fitid(d, -89.99, "AMAZON.COM")
        h2 = _content_hash_fitid(d, -89.99, "AMAZON.COM")
        assert h1 == h2

    def test_different_amounts_produce_different_hash(self):
        from datetime import date
        d = date(2024, 1, 5)
        h1 = _content_hash_fitid(d, -89.99, "AMAZON.COM")
        h2 = _content_hash_fitid(d, -90.00, "AMAZON.COM")
        assert h1 != h2

    def test_different_dates_produce_different_hash(self):
        from datetime import date
        h1 = _content_hash_fitid(date(2024, 1, 5), -89.99, "AMAZON.COM")
        h2 = _content_hash_fitid(date(2024, 1, 6), -89.99, "AMAZON.COM")
        assert h1 != h2

    def test_hash_length_is_16(self):
        from datetime import date
        h = _content_hash_fitid(date(2024, 1, 1), 100.0, "TEST")
        assert len(h) == 16


class TestOFXFileImporter:
    def test_parse_ofx_file_returns_transactions(self):
        content = (FIXTURES / "vanguard_sample.ofx").read_bytes()
        txns = parse_ofx_file(content)
        assert isinstance(txns, list)
        # Should have at least the INVBANKTRAN
        assert len(txns) >= 1

    def test_parse_ofx_file_handles_corrupt_input(self):
        txns = parse_ofx_file(b"not an ofx file")
        assert txns == []


class TestAutoCsvDetection:
    def test_detects_chase(self):
        content = (FIXTURES / "chase_sample.csv").read_text()
        txns = parse_csv_auto(content)
        assert len(txns) == 5

    def test_detects_citibank(self):
        content = (FIXTURES / "citibank_sample.csv").read_text()
        txns = parse_csv_auto(content)
        assert len(txns) == 5

    def test_generic_fallback_with_standard_columns(self):
        csv = "Date,Description,Amount\n01/15/2024,RENT PAYMENT,-1200.00\n01/20/2024,SALARY,3000.00\n"
        txns = parse_csv_auto(csv)
        assert len(txns) == 2
        assert txns[0].amount == pytest.approx(-1200.00)
        assert txns[1].amount == pytest.approx(3000.00)

    def test_generic_fallback_debit_credit_columns(self):
        csv = "Date,Description,Debit,Credit\n01/05/2024,GROCERIES,45.00,\n01/06/2024,PAYCHECK,,2000.00\n"
        txns = parse_csv_auto(csv)
        assert len(txns) == 2
        grocery = next(t for t in txns if "GROCERIES" in t.name)
        paycheck = next(t for t in txns if "PAYCHECK" in t.name)
        assert grocery.amount == pytest.approx(-45.00)
        assert paycheck.amount == pytest.approx(2000.00)

    def test_generic_debit_credit_with_a_check_number_column(self):
        """A credit-union export: a check-number column beside Debit and Credit."""
        csv = "Date,No.,Description,Debit,Credit\n03/02/2026,1042,CHECK 1042,120.00,\n03/03/2026,,DEPOSIT,,800.00\n"
        txns, institution = parse_csv_auto_with_institution(csv)
        assert institution == "Generic"
        assert [t.amount for t in txns] == [pytest.approx(-120.00), pytest.approx(800.00)]

    def test_generic_signs_unsigned_amounts_from_a_type_column(self):
        """Unsigned amounts with a Debit/Credit type column, a memo for rows with
        no description, and a running balance."""
        csv = (
            "DATE,TRANSACTION TYPE,DESCRIPTION,AMOUNT,ID,MEMO,CURRENT BALANCE,STATUS\n"
            "03/02/2026,DEBIT,ZQX MART,25.00,1,,975.00,Posted\n"
            "03/03/2026,CREDIT,,500.00,2,PAYROLL ACME,\"1,475.00\",Posted\n"
        )
        txns, institution = parse_csv_auto_with_institution(csv)
        assert institution == "Generic"
        assert [t.amount for t in txns] == [pytest.approx(-25.00), pytest.approx(500.00)]
        assert [t.trntype for t in txns] == ["DEBIT", "CREDIT"]
        assert txns[1].name == "PAYROLL ACME"
        assert [t._balance for t in txns] == [pytest.approx(975.00), pytest.approx(1475.00)]

    def test_generic_prefers_the_extended_description(self):
        csv = (
            "Transaction ID,Posting Date,Transaction Type,Amount,Description,Balance,Extended Description\n"
            "T1,3/2/2026,Debit,-40.00,POS,960.00,ZQX BISTRO SPRINGFIELD\n"
            "T2,3/3/2026,Credit,100.00,DEPOSIT,1060.00,\n"
        )
        txns = parse_csv_auto(csv)
        assert [t.name for t in txns] == ["ZQX BISTRO SPRINGFIELD", "DEPOSIT"]
        assert [t.amount for t in txns] == [pytest.approx(-40.00), pytest.approx(100.00)]
        assert txns[-1]._balance == pytest.approx(1060.00)

    def test_a_type_column_with_other_words_leaves_the_sign_alone(self):
        csv = "Date,Type,Description,Amount\n03/02/2026,Sale,ZQX MART,-12.00\n03/03/2026,Return,ZQX MART,12.00\n"
        assert [t.amount for t in parse_csv_auto(csv)] == [pytest.approx(-12.00), pytest.approx(12.00)]

    def test_generic_handles_parentheses_negatives(self):
        csv = "Date,Description,Amount\n01/01/2024,CHARGE,(99.99)\n"
        txns = parse_csv_auto(csv)
        assert len(txns) == 1
        assert txns[0].amount == pytest.approx(-99.99)

    def test_generic_handles_comma_formatted_amounts(self):
        csv = "Date,Description,Amount\n01/01/2024,RENT,\"(1,500.00)\"\n"
        txns = parse_csv_auto(csv)
        assert len(txns) == 1
        assert txns[0].amount == pytest.approx(-1500.00)

    def test_generic_handles_iso_dates(self):
        csv = "Date,Description,Amount\n2024-03-15,TRANSFER,-500.00\n"
        txns = parse_csv_auto(csv)
        assert len(txns) == 1
        assert txns[0].date_posted.year == 2024
        assert txns[0].date_posted.month == 3

    def test_returns_empty_for_unrecognisable_csv(self):
        csv = "foo,bar,baz\n1,2,3\n"
        txns = parse_csv_auto(csv)
        assert txns == []

    def test_wellsfargo_headerless_detection(self):
        csv = '"01/15/2024","-29.99","*","*","AMAZON.COM AMZN.COM/BILL"\n"01/16/2024","3500.00","*","*","DIRECT DEPOSIT"\n'
        txns = parse_csv_auto(csv)
        assert len(txns) == 2
        assert txns[0].amount == pytest.approx(-29.99)
        assert txns[1].amount == pytest.approx(3500.00)

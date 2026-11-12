"""A CSV import holds at most CSV_MAX_ROWS transactions."""
import pytest
from fastapi import HTTPException

from app.core.uploads import CSV_MAX_ROWS, require_csv_rows

pytestmark = pytest.mark.unit

HEADER = "Date,Description,Amount\n"


def _csv(rows: int, row: str = "2026-01-02,Coffee,-4.50\n") -> bytes:
    return (HEADER + row * rows).encode()


def test_the_cap_itself_is_accepted():
    require_csv_rows(_csv(CSV_MAX_ROWS))


def test_one_row_over_is_refused():
    with pytest.raises(HTTPException) as exc:
        require_csv_rows(_csv(CSV_MAX_ROWS + 1))
    assert exc.value.status_code == 413
    assert "1,000 transactions" in exc.value.detail


def test_blank_lines_do_not_count():
    require_csv_rows(_csv(CSV_MAX_ROWS) + b"\n\n,,\n" * 50)


def test_a_quoted_newline_is_one_row():
    row = '2026-01-02,"Coffee\nand cake",-4.50\n'
    require_csv_rows(_csv(CSV_MAX_ROWS, row))


def test_latin1_and_bom_files_are_counted():
    require_csv_rows(b"\xef\xbb\xbf" + _csv(10))
    with pytest.raises(HTTPException):
        require_csv_rows(("Date,Payee\n" + "2026-01-02,Caf\xe9\n" * (CSV_MAX_ROWS + 1)).encode("latin-1"))

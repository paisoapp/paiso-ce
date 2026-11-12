"""Smart CSV/OFX parser: auto-detects institution format from headers."""
import csv
import hashlib
import io
from datetime import date, datetime
from typing import Callable

import structlog

from app.core.validation import finite_amount
from app.modules.aggregator.ofx_parser import ParsedTransaction, parse_ofx_response

log = structlog.get_logger()


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _content_hash_fitid(date_val: date, amount: float, description: str) -> str:
    """Generate a stable deduplication ID from transaction content."""
    raw = f"{date_val.isoformat()}{amount:.4f}{description}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def number_repeats(ids: list[str]) -> list[str]:
    """Give repeated content ids within one file their own value.

    A CSV with no bank transaction id is deduplicated on date, amount and
    description, so two real $5 coffees on the same day collided and one was
    dropped. Walking the file in order, the first row with an id
    keeps it unchanged, so rows imported before this fix still match on a
    re-import; the second and later get a hash of the id and their occurrence
    number, cut to the same length. Importing the same file twice still adds
    nothing, because the numbering is the same each time.

    The limit: if one statement ends between two identical same-day purchases
    and the next starts with the second, that file numbers it as the first
    and it is still taken for a duplicate. Nothing in the file tells them apart.
    """
    seen: dict[str, int] = {}
    out: list[str] = []
    for ext_id in ids:
        n = seen.get(ext_id, 0) + 1
        seen[ext_id] = n
        if n == 1:
            out.append(ext_id)
        else:
            digest = hashlib.sha256(f"{ext_id}#{n}".encode()).hexdigest()
            out.append(digest[: len(ext_id)])
    return out


def _clean_amount(raw: str) -> float | None:
    """
    Parse an amount string into a float.
    Handles: commas, $, leading/trailing spaces, parentheses for negatives.
      e.g. "(1,234.56)" → -1234.56,  "-$99.00" → -99.0,  "1,000" → 1000.0
    """
    s = raw.strip().replace(",", "").replace("$", "").replace(" ", "")
    if not s or s in ("-", "+"):
        return None
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        val = finite_amount(float(s))
        return -abs(val) if negative else val
    except ValueError:
        return None


_DATE_FORMATS = [
    "%m/%d/%Y",   # 01/31/2024
    "%m-%d-%Y",   # 01-31-2024
    "%Y-%m-%d",   # 2024-01-31
    "%Y/%m/%d",   # 2024/01/31
    "%m/%d/%y",   # 01/31/24
    "%m-%d-%y",   # 01-31-24
    "%d/%m/%Y",   # 31/01/2024  (some UK exports)
    "%b %d, %Y",  # Jan 31, 2024
    "%B %d, %Y",  # January 31, 2024
    "%d-%b-%Y",   # 31-Jan-2024
]


def _parse_date(raw: str) -> date | None:
    s = raw.strip()
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _norm_headers(fieldnames: list[str] | None) -> dict[str, str]:
    """Return {lowercase_stripped: original} mapping of CSV headers."""
    if not fieldnames:
        return {}
    return {h.strip().lower(): h for h in fieldnames}


def _find_col(norm_map: dict[str, str], candidates: list[str]) -> str | None:
    """Return the first original column name that matches any candidate (case-insensitive)."""
    for c in candidates:
        if c.lower() in norm_map:
            return norm_map[c.lower()]
    return None


# ---------------------------------------------------------------------------
# Institution-specific parsers
# ---------------------------------------------------------------------------

def parse_chase_csv(content: str) -> list[ParsedTransaction]:
    """Chase: Transaction Date, Post Date / Posting Date, Description, Amount, Balance"""
    results: list[ParsedTransaction] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        try:
            if not any(row.values()):
                continue
            # Chase exports use either "Transaction Date" or fall back to "Posting Date"
            date_raw = (row.get("Transaction Date") or row.get("Posting Date") or "").strip()
            if not date_raw:
                continue
            date_val = _parse_date(date_raw)
            if not date_val:
                continue
            description = row.get("Description", "").strip()
            amount = _clean_amount(row.get("Amount", "0"))
            if amount is None:
                continue
            memo = row.get("Memo", "").strip()
            category = row.get("Category", "").strip()
            trntype = row.get("Type", "OTHER").strip() or "OTHER"
            balance_raw = row.get("Balance", "").strip()
            balance_val = _clean_amount(balance_raw) if balance_raw else None
            txn = ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype=trntype,
                name=description,
                memo=memo or category,
                bank_category=category,
            )
            txn._balance = balance_val  # type: ignore[attr-defined]
            results.append(txn)
        except Exception as exc:
            log.warning("csv_parsers.chase.row_error", error=str(exc))
    return results


def parse_citibank_csv(content: str) -> list[ParsedTransaction]:
    """Citibank checking/CC: Status, Date, Description, Debit, Credit[, Member Name]"""
    results: list[ParsedTransaction] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        try:
            if not any(row.values()):
                continue
            date_raw = row.get("Date", "").strip()
            if not date_raw:
                continue
            date_val = _parse_date(date_raw)
            if not date_val:
                continue
            description = row.get("Description", "").strip()
            debit_raw = row.get("Debit", "").strip()
            credit_raw = row.get("Credit", "").strip()
            # Member Name is present in credit card exports
            member_name = row.get("Member Name", "").strip()
            if debit_raw:
                v = _clean_amount(debit_raw)
                if v is None:
                    continue
                amount, trntype = -abs(v), "DEBIT"
            elif credit_raw:
                v = _clean_amount(credit_raw)
                if v is None:
                    continue
                amount, trntype = abs(v), "CREDIT"
            else:
                continue
            results.append(ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype=trntype,
                name=description,
                member_name=member_name,
            ))
        except Exception as exc:
            log.warning("csv_parsers.citibank.row_error", error=str(exc))
    return results


def parse_bofa_csv(content: str) -> list[ParsedTransaction]:
    """Bank of America: Date, Description, Amount, Running Bal."""
    results: list[ParsedTransaction] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        try:
            if not any(row.values()):
                continue
            date_raw = (row.get("Date") or row.get("Posted Date") or "").strip()
            if not date_raw:
                continue
            date_val = _parse_date(date_raw)
            if not date_val:
                continue
            description = (row.get("Description") or row.get("Payee") or "").strip()
            amount = _clean_amount(row.get("Amount", "0"))
            if amount is None:
                continue
            results.append(ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype="CREDIT" if amount >= 0 else "DEBIT",
                name=description,
            ))
        except Exception as exc:
            log.warning("csv_parsers.bofa.row_error", error=str(exc))
    return results


def parse_amex_csv(content: str) -> list[ParsedTransaction]:
    """American Express: Date, Description, Amount (positive = charge, so flip sign)"""
    results: list[ParsedTransaction] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        try:
            if not any(row.values()):
                continue
            date_raw = (row.get("Date") or "").strip()
            if not date_raw:
                continue
            date_val = _parse_date(date_raw)
            if not date_val:
                continue
            description = (row.get("Description") or row.get("Merchant") or "").strip()
            raw_amount = row.get("Amount", "0")
            amount = _clean_amount(raw_amount)
            if amount is None:
                continue
            # Amex CSVs: positive = charge (debit), negative = credit/payment
            amount = -amount
            results.append(ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype="CREDIT" if amount >= 0 else "DEBIT",
                name=description,
                bank_category=(row.get("Category") or "").strip(),
            ))
        except Exception as exc:
            log.warning("csv_parsers.amex.row_error", error=str(exc))
    return results


def parse_wellsfargo_csv(content: str) -> list[ParsedTransaction]:
    """Wells Fargo: no header row — 5 columns: date, amount, *, *, description"""
    results: list[ParsedTransaction] = []
    reader = csv.reader(io.StringIO(content))
    for row in reader:
        try:
            if len(row) < 5:
                continue
            date_val = _parse_date(row[0])
            if not date_val:
                continue
            amount = _clean_amount(row[1])
            if amount is None:
                continue
            description = row[4].strip()
            results.append(ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype="CREDIT" if amount >= 0 else "DEBIT",
                name=description,
            ))
        except Exception as exc:
            log.warning("csv_parsers.wellsfargo.row_error", error=str(exc))
    return results


# ---------------------------------------------------------------------------
# Generic fallback parser
# ---------------------------------------------------------------------------

#: Values of a direction column that mean money went out or came in.
_DEBIT_WORDS = {"debit", "dr", "withdrawal"}
_CREDIT_WORDS = {"credit", "cr", "deposit"}


def _parse_generic_csv(content: str, norm_map: dict[str, str]) -> list[ParsedTransaction]:
    """
    Column-detection fallback for unknown CSV formats.
    Tries to find date, amount (or debit+credit), and description columns.
    """
    date_col = _find_col(norm_map, [
        "date", "transaction date", "post date", "posting date", "posted date",
        "trans date", "settlement date", "value date",
    ])
    amount_col = _find_col(norm_map, [
        "amount", "transaction amount", "net amount", "value",
    ])
    debit_col = _find_col(norm_map, ["debit", "withdrawal", "withdrawals", "payment", "charge"])
    credit_col = _find_col(norm_map, ["credit", "deposit", "deposits"])
    desc_col = _find_col(norm_map, [
        "description", "memo", "name", "merchant", "payee", "details",
        "transaction description", "narrative", "particulars",
    ])
    # Capital One, Discover and others label each row with their own category.
    category_col = _find_col(norm_map, ["category", "transaction category"])
    # Many credit unions print every amount unsigned and say which way it went
    # in a column of its own ("Debit" / "Credit").
    type_col = _find_col(norm_map, ["transaction type", "type", "debit/credit", "dr/cr"])
    # The account balance after each row, when the bank includes it.
    balance_col = _find_col(norm_map, [
        "balance", "running balance", "current balance", "ledger balance",
    ])
    # A fuller description than the short one, when the bank gives both.
    long_desc_col = _find_col(norm_map, ["extended description", "full description"])
    memo_col = _find_col(norm_map, ["memo", "notes"])
    if memo_col == desc_col:
        memo_col = None

    if not date_col or not desc_col:
        log.warning("csv_parsers.generic.missing_required_columns",
                    date_col=date_col, desc_col=desc_col)
        return []

    if not amount_col and not (debit_col or credit_col):
        log.warning("csv_parsers.generic.missing_amount_column")
        return []

    results: list[ParsedTransaction] = []
    reader = csv.DictReader(io.StringIO(content))
    for row in reader:
        try:
            if not any(row.values()):
                continue
            date_raw = row.get(date_col, "").strip()
            if not date_raw:
                continue
            date_val = _parse_date(date_raw)
            if not date_val:
                continue
            memo = (row.get(memo_col) or "").strip() if memo_col else ""
            description = (
                ((row.get(long_desc_col) or "").strip() if long_desc_col else "")
                or (row.get(desc_col) or "").strip()
                or memo
            )

            if amount_col:
                amount = _clean_amount(row.get(amount_col, "0"))
                if amount is None:
                    continue
                direction = (row.get(type_col) or "").strip().lower() if type_col else ""
                if direction in _DEBIT_WORDS:
                    amount = -abs(amount)
                elif direction in _CREDIT_WORDS:
                    amount = abs(amount)
                trntype = "CREDIT" if amount >= 0 else "DEBIT"
            else:
                debit_raw = row.get(debit_col or "", "").strip() if debit_col else ""
                credit_raw = row.get(credit_col or "", "").strip() if credit_col else ""
                if debit_raw:
                    v = _clean_amount(debit_raw)
                    if v is None:
                        continue
                    amount, trntype = -abs(v), "DEBIT"
                elif credit_raw:
                    v = _clean_amount(credit_raw)
                    if v is None:
                        continue
                    amount, trntype = abs(v), "CREDIT"
                else:
                    continue

            txn = ParsedTransaction(
                fitid=_content_hash_fitid(date_val, amount, description),
                date_posted=date_val,
                amount=amount,
                trntype=trntype,
                name=description,
                memo=memo,
                bank_category=(row.get(category_col) or "").strip() if category_col else "",
            )
            balance_raw = (row.get(balance_col) or "").strip() if balance_col else ""
            # The import stores the latest row's balance as the account's.
            txn._balance = _clean_amount(balance_raw) if balance_raw else None  # type: ignore[attr-defined]
            results.append(txn)
        except Exception as exc:
            log.warning("csv_parsers.generic.row_error", error=str(exc))
    return results


# ---------------------------------------------------------------------------
# Institution signature detection
# ---------------------------------------------------------------------------

_SIGNATURES: list[tuple[set[str], Callable[[str], list[ParsedTransaction]], str]] = [
    # Chase credit card: "Transaction Date" + "Post Date" (or "Posting Date")
    ({"transaction date", "post date", "description", "amount"}, parse_chase_csv, "Chase"),
    ({"transaction date", "posting date", "description", "amount"}, parse_chase_csv, "Chase"),
    # Chase older format: "Details" column + "Transaction Date"
    ({"transaction date", "details", "description", "amount"}, parse_chase_csv, "Chase"),
    # Chase checking: "Details" + "Posting Date" (no Transaction Date column)
    ({"details", "posting date", "description", "amount"}, parse_chase_csv, "Chase"),
    # Citibank credit card: has Member Name column
    ({"status", "date", "description", "debit", "credit", "member name"}, parse_citibank_csv, "Citibank"),
    # Citibank checking: debit+credit split
    ({"status", "date", "description", "debit", "credit"}, parse_citibank_csv, "Citibank"),
    # Bank of America
    ({"date", "description", "amount", "running bal."}, parse_bofa_csv, "Bank of America"),
    # American Express (extended export)
    ({"date", "description", "amount", "extended details"}, parse_amex_csv, "American Express"),
    # American Express (simple export)
    ({"date", "description", "amount", "reference"}, parse_amex_csv, "American Express"),
]


def _detect_parser(
    norm_headers: set[str],
) -> tuple[Callable[[str], list[ParsedTransaction]], str] | None:
    for required, parser, institution in _SIGNATURES:
        if required.issubset(norm_headers):
            return parser, institution
    return None


# ---------------------------------------------------------------------------
# Wells Fargo detection (headerless CSV)
# ---------------------------------------------------------------------------

def _looks_like_wellsfargo(content: str) -> bool:
    """Wells Fargo CSVs have no header row and 5 quoted columns."""
    first_line = content.strip().split("\n")[0]
    try:
        row = next(csv.reader([first_line]))
    except Exception:
        return False
    if len(row) != 5:
        return False
    # First field should parse as a date, second as a dollar amount
    return bool(_parse_date(row[0])) and bool(_clean_amount(row[1]))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_csv_auto(content: str) -> list[ParsedTransaction]:
    """
    Auto-detect the institution format from CSV headers and parse accordingly.
    Falls back to a generic column-detection parser for unknown formats.
    """
    transactions, _ = parse_csv_auto_with_institution(content)
    return transactions


def _choose_parser(
    content: str,
) -> tuple[Callable[[str], list[ParsedTransaction]], str, list[str] | None]:
    """The parser for this file, the institution it names, and the header row
    (None for a headerless Wells Fargo export)."""
    # Wells Fargo has no header row — detect before trying DictReader
    if _looks_like_wellsfargo(content):
        return parse_wellsfargo_csv, "Wells Fargo", None

    reader = csv.DictReader(io.StringIO(content))
    headers = list(reader.fieldnames or [])
    norm_map = _norm_headers(headers)

    result = _detect_parser(set(norm_map.keys()))
    if result:
        parser, institution = result
        return parser, institution, headers
    return (lambda c: _parse_generic_csv(c, norm_map)), "Generic", headers


def parse_csv_auto_with_institution(content: str) -> tuple[list[ParsedTransaction], str]:
    """
    Auto-detect institution and parse CSV. Returns (transactions, institution_name).
    institution_name is "Generic" if no specific institution detected.
    """
    parser, institution, _ = _choose_parser(content)
    log.info("csv_parsers.detected", institution=institution)
    transactions = parser(content)
    for txn, ext_id in zip(transactions, number_repeats([t.fitid for t in transactions])):
        txn.fitid = ext_id
    return transactions, institution


_DATE_HEADERS = ["transaction date", "posting date", "post date", "date", "posted date",
                 "trans date", "settlement date", "value date"]
_AMOUNT_HEADERS = ["amount", "transaction amount", "net amount", "value",
                   "debit", "withdrawal", "withdrawals", "credit", "deposit", "deposits"]


def _why_unreadable(row: list[str], headers: list[str] | None) -> str:
    """A plain reason a row could not be read, for the import preview."""
    if headers is None:  # Wells Fargo: date, amount, *, *, description
        date_cells, amount_cells = row[:1], row[1:2]
    else:
        norm = [h.strip().lower() for h in headers]
        def cells(names: list[str]) -> list[str]:
            return [row[i] for i, h in enumerate(norm) if h in names and i < len(row)]
        date_cells, amount_cells = cells(_DATE_HEADERS), cells(_AMOUNT_HEADERS)
    if date_cells and not any(c.strip() for c in date_cells):
        return "It has no date."
    if date_cells and not any(_parse_date(c) for c in date_cells if c.strip()):
        return f"The date \"{next(c for c in date_cells if c.strip()).strip()}\" is not one Paiso can read."
    if amount_cells and not any(c.strip() for c in amount_cells):
        return "It has no amount."
    if amount_cells and all(_clean_amount(c) is None for c in amount_cells if c.strip()):
        return f"The amount \"{next(c for c in amount_cells if c.strip()).strip()}\" is not a number."
    return "Paiso could not read this row."


def unreadable_rows(content: str) -> tuple[int, list[dict]]:
    """How many rows the file has, and the ones the import would leave out.

    The parsers skip a row they cannot read without a word, which is right for
    a bank's own export but left a user's file short with no explanation.
   Each row is re-read on its own with the same parser, so the answer
    is exactly what the import does. The per-row pass only runs when rows are
    missing.

    Returns ``(row_count, [{"line": n, "values": [...], "reason": str}])``,
    where ``line`` is the row's line number in the file.
    """
    parser, _, headers = _choose_parser(content)
    rows = list(csv.reader(io.StringIO(content)))
    first = 0 if headers is None else 1
    data = [(i + 1, r) for i, r in enumerate(rows[first:], start=first)
            if any(c.strip() for c in r)]
    if len(parser(content)) >= len(data):
        return len(data), []

    out: list[dict] = []
    for line, row in data:
        buf = io.StringIO()
        w = csv.writer(buf)
        if headers is not None:
            w.writerow(headers)
        w.writerow(row)
        if not parser(buf.getvalue()):
            out.append({"line": line, "values": row, "reason": _why_unreadable(row, headers)})
    return len(data), out


def parse_ofx_file(file_content: bytes) -> list[ParsedTransaction]:
    """Parse an uploaded .ofx/.qfx file (bytes) into a flat transaction list."""
    return parse_ofx_file_full(file_content)[0]


def parse_ofx_file_full(file_content: bytes):
    """Parse an OFX/QFX file and return (transactions, accounts, statement_balance).

    statement_balance is the LEDGERBAL amount from the OFX statement, or None
    if not present. accounts is the list of ParsedAccount from the file.
    """
    result = parse_ofx_result(file_content)
    if result is None:
        return [], [], None
    # Prefer LEDGERBAL (first balance entry) as the authoritative statement balance
    stmt_balance = result.balances[0].amount if result.balances else None
    return result.transactions, result.accounts, stmt_balance


def parse_ofx_result(file_content: bytes):
    """Parse an OFX/QFX file and return the full OFXResult (or None on failure).

    Superset of parse_ofx_file_full — also exposes holdings and structured
    investment income (dividends / reinvestments)."""
    try:
        try:
            raw = file_content.decode("utf-8")
        except UnicodeDecodeError:
            raw = file_content.decode("latin-1")
        return parse_ofx_response(raw)
    except Exception as exc:
        log.warning("csv_parsers.ofx_file_error", error=str(exc))
        return None

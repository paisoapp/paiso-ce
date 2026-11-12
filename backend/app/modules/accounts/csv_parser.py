"""CSV upload, parsing, and import logic."""
import csv
import hashlib
import io
import uuid
from datetime import date

import chardet

from app.core.storage import get_storage
from app.core.validation import finite_amount
from app.modules.aggregator.csv_parsers import number_repeats

CANONICAL_FIELDS = [
    "date_posted",
    "description",
    "amount",
    "balance",
    "transaction_type",
    "category",
    "tags",
    "notes",
]


# ── File storage ──────────────────────────────────────────────────────────────
#
# A statement waits here between the wizard's upload, validate and commit
# steps. Each file is kept under its uploader's id, so a request can only ever
# reach its own user's files: knowing another user's upload id is not enough.
# The account wipe in app.api.auth deletes the whole prefix.

def _upload_key(user_id: int, upload_id: str) -> str:
    """The storage key for one staged statement. Raises FileNotFoundError for
    an id that is not a UUID, which is all the server ever hands out, so a
    crafted id reads exactly like a missing one."""
    try:
        canonical = str(uuid.UUID(upload_id))
    except (ValueError, AttributeError, TypeError):
        raise FileNotFoundError(f"Upload {upload_id!r} not found")
    return f"{upload_prefix(user_id)}{canonical}"


def upload_prefix(user_id: int) -> str:
    """Where one user's staged statements live."""
    return f"imports/{int(user_id)}/"


async def save_upload(user_id: int, raw_bytes: bytes) -> str:
    upload_id = str(uuid.uuid4())
    await get_storage().put(_upload_key(user_id, upload_id), raw_bytes)
    return upload_id


async def load_upload(user_id: int, upload_id: str) -> bytes:
    """The staged bytes. Missing, expired and another user's upload all raise
    the same FileNotFoundError."""
    raw = await get_storage().get(_upload_key(user_id, upload_id))
    if raw is None:
        raise FileNotFoundError(f"Upload {upload_id!r} not found")
    return raw


async def delete_upload(user_id: int, upload_id: str) -> None:
    try:
        key = _upload_key(user_id, upload_id)
    except FileNotFoundError:
        return
    await get_storage().delete(key)


# ── Detection ─────────────────────────────────────────────────────────────────

def detect_encoding(raw: bytes) -> str:
    result = chardet.detect(raw[:65536])
    return result.get("encoding") or "utf-8"


def detect_delimiter(text: str) -> str:
    sample = "\n".join(text.splitlines()[:20])
    sniffer = csv.Sniffer()
    try:
        dialect = sniffer.sniff(sample, delimiters=",\t;|")
        return dialect.delimiter
    except csv.Error:
        return ","


def _clean_row(row: dict) -> dict[str, str]:
    """A CSV row with every cell a string.

    csv.DictReader fills the cells a short row lacks with None (a statement's
    footnote line has one cell) and gathers a long row's extra cells as a list
    under the key None. Both broke the parsing below with a 500.
    """
    return {k: v or "" for k, v in row.items() if k is not None}


def parse_csv_preview(raw: bytes, max_rows: int = 5) -> dict:
    """Return detected columns and sample rows."""
    encoding = detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delimiter = detect_delimiter(text)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    columns = reader.fieldnames or []
    rows: list[dict] = []
    for i, row in enumerate(reader):
        if i >= max_rows:
            break
        rows.append(_clean_row(row))
    return {"columns": list(columns), "sample_rows": rows, "encoding": encoding, "delimiter": delimiter}


# ── Import ────────────────────────────────────────────────────────────────────

def _parse_amount(value: str) -> float:
    """Parse an amount string, removing currency symbols and commas."""
    cleaned = value.replace("$", "").replace(",", "").replace(" ", "").strip()
    try:
        return finite_amount(float(cleaned))
    except ValueError:
        raise ValueError(f"Cannot parse amount: {value!r}")


def _parse_date(value: str) -> date:
    from dateutil import parser as dateparser
    return dateparser.parse(value).date()


def _content_hash(account_id: int, date_posted: date, amount: float, description: str) -> str:
    blob = f"{account_id}|{date_posted}|{amount:.4f}|{description}"
    return hashlib.sha256(blob.encode()).hexdigest()[:32]


def _parse_row(
    row: dict,
    column_map: dict[str, str],
    account_id: int,
    amount_debit_column: str | None,
    amount_credit_column: str | None,
) -> tuple[dict | None, dict[str, str]]:
    """
    Parse a single CSV row using the column mapping.
    Returns (transaction_dict, errors).  If errors is empty the row is valid.
    When the row cannot be parsed at all, transaction_dict is None.
    Partial results are returned when possible so the frontend can pre-fill the editor.
    """
    errors: dict[str, str] = {}
    result: dict = {}

    # ── Date ─────────────────────────────────────────────────────────────────
    date_col = column_map.get("date_posted")
    date_val = None
    if not date_col or date_col not in row:
        errors["date_posted"] = "Date column not found in row"
    else:
        raw_date = row[date_col].strip()
        if not raw_date:
            errors["date_posted"] = "Date is empty"
        else:
            try:
                date_val = _parse_date(raw_date)
                result["date_posted"] = date_val
            except Exception:
                errors["date_posted"] = f"Cannot parse date: {raw_date!r}"
                result["date_posted_raw"] = raw_date

    # ── Description ──────────────────────────────────────────────────────────
    desc_col = column_map.get("description")
    description = ""
    if desc_col and desc_col in row:
        description = row[desc_col].strip()
    if not description:
        errors["description"] = "Description is empty"
    result["description"] = description

    # ── Amount ───────────────────────────────────────────────────────────────
    amount: float | None = None
    txn_type: str | None = None
    if amount_debit_column and amount_credit_column:
        debit_raw = row.get(amount_debit_column, "").strip()
        credit_raw = row.get(amount_credit_column, "").strip()
        if not debit_raw and not credit_raw:
            errors["amount"] = "Both debit and credit columns are empty"
        else:
            try:
                debit = abs(_parse_amount(debit_raw)) if debit_raw else 0.0
                credit = abs(_parse_amount(credit_raw)) if credit_raw else 0.0
                amount = credit - debit
                txn_type = "credit" if amount >= 0 else "debit"
            except ValueError as exc:
                errors["amount"] = str(exc)
    else:
        amount_col = column_map.get("amount")
        if not amount_col or amount_col not in row:
            errors["amount"] = "Amount column not found in row"
        else:
            raw_amt = row[amount_col].strip()
            if not raw_amt:
                errors["amount"] = "Amount is empty"
            else:
                try:
                    amount = _parse_amount(raw_amt)
                    txn_type_col = column_map.get("transaction_type")
                    if txn_type_col and txn_type_col in row:
                        txn_type = row[txn_type_col].strip().lower() or None
                    else:
                        txn_type = "credit" if amount >= 0 else "debit"
                except ValueError:
                    errors["amount"] = f"Cannot parse amount: {raw_amt!r}"
                    result["amount_raw"] = raw_amt

    if amount is not None:
        result["amount"] = amount
        result["transaction_type"] = txn_type

    # ── Optional fields ───────────────────────────────────────────────────────
    balance_col = column_map.get("balance")
    if balance_col and balance_col in row and row[balance_col].strip():
        try:
            result["balance"] = _parse_amount(row[balance_col])
        except ValueError:
            pass  # balance is optional; don't flag as error

    notes_col = column_map.get("notes")
    result["notes"] = row.get(notes_col, "").strip() if notes_col else None

    tags_col = column_map.get("tags")
    result["tags"] = row.get(tags_col, "").strip() if tags_col else None

    category_col = column_map.get("bank_category")
    result["bank_category"] = row.get(category_col, "").strip()[:64] if category_col else None

    if errors:
        return result, errors

    # ── Build final transaction dict ──────────────────────────────────────────
    ext_id = _content_hash(account_id, result["date_posted"], result["amount"], result["description"])
    txn = {
        "account_id": account_id,
        "date_posted": result["date_posted"],
        "amount": result["amount"],
        "transaction_type": result["transaction_type"],
        "description": result["description"],
        "balance": result.get("balance"),
        "notes": result.get("notes") or None,
        "tags": result.get("tags") or None,
        "bank_category": result.get("bank_category") or None,
        "source": "csv",
        "external_id": ext_id,
    }
    return txn, {}


def _number_repeats(transactions: list[dict]) -> None:
    """Same-day repeats in one file keep their own rows; see
    number_repeats in app.modules.aggregator.csv_parsers."""
    for txn, ext_id in zip(transactions, number_repeats([t["external_id"] for t in transactions])):
        txn["external_id"] = ext_id


def validate_rows(
    raw: bytes,
    column_map: dict[str, str],
    account_id: int,
    amount_debit_column: str | None = None,
    amount_credit_column: str | None = None,
) -> dict:
    """
    Parse every row in the CSV; return valid transactions and invalid rows with
    per-field error details.

    Returns:
        {
          "valid": [transaction_dict, ...],
          "invalid": [
              {
                  "row_index": int,        # 0-based, excluding header
                  "raw": {col: value, ...},
                  "partial": {field: ...}, # whatever we could parse
                  "errors": {field: msg},
              },
              ...
          ]
        }
    """
    encoding = detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delimiter = detect_delimiter(text)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    valid: list[dict] = []
    invalid: list[dict] = []

    for idx, row in enumerate(reader):
        row = _clean_row(row)
        txn, errors = _parse_row(row, column_map, account_id, amount_debit_column, amount_credit_column)
        if errors:
            invalid.append({
                "row_index": idx,
                "raw": dict(row),
                "partial": txn or {},
                "errors": errors,
            })
        elif txn:
            valid.append(txn)

    _number_repeats(valid)
    return {"valid": valid, "invalid": invalid}


def apply_corrections(
    raw: bytes,
    column_map: dict[str, str],
    account_id: int,
    corrections: list[dict],
    amount_debit_column: str | None = None,
    amount_credit_column: str | None = None,
) -> tuple[list[dict], list[dict]]:
    """
    Re-parse the CSV but for rows listed in corrections, override raw cell values
    with the user's edits before parsing.

    Returns (valid_transactions, still_invalid_rows).
    corrections: [{"row_index": int, "fields": {"date_posted": "2024-01-15", "amount": "-42.00", ...}}]
    """
    encoding = detect_encoding(raw)
    text = raw.decode(encoding, errors="replace")
    delimiter = detect_delimiter(text)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    # Build a lookup of corrections by row_index
    correction_map: dict[int, dict] = {c["row_index"]: c["fields"] for c in corrections}

    valid: list[dict] = []
    still_invalid: list[dict] = []

    for idx, row in enumerate(reader):
        row = _clean_row(row)
        if idx in correction_map:
            overrides = correction_map[idx]
            patched_row = dict(row)
            # Overrides are keyed by canonical field name (date_posted, amount, etc.)
            # Map them back to the CSV column names before passing to _parse_row
            for field, value in overrides.items():
                col_name = column_map.get(field)
                if col_name:
                    patched_row[col_name] = value
                else:
                    # For split debit/credit, field might be "debit" or "credit"
                    if field == "debit" and amount_debit_column:
                        patched_row[amount_debit_column] = value
                    elif field == "credit" and amount_credit_column:
                        patched_row[amount_credit_column] = value
            row = patched_row

        txn, errors = _parse_row(row, column_map, account_id, amount_debit_column, amount_credit_column)
        if errors:
            still_invalid.append({
                "row_index": idx,
                "raw": dict(row),
                "partial": txn or {},
                "errors": errors,
            })
        elif txn:
            valid.append(txn)

    _number_repeats(valid)
    return valid, still_invalid


def parse_and_map(
    raw: bytes,
    column_map: dict[str, str],  # canonical_field -> csv_column
    account_id: int,
    amount_debit_column: str | None = None,
    amount_credit_column: str | None = None,
) -> list[dict]:
    """
    Parse a CSV using the user-provided column mapping.
    Returns only valid transaction dicts ready for DB insertion (malformed rows skipped).
    """
    result = validate_rows(raw, column_map, account_id, amount_debit_column, amount_credit_column)
    return result["valid"]

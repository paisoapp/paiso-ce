"""File import endpoints.

CSV: upload preview → column mapping → commit, plus smart bank import.
OFX/QFX: preview against a chosen account → commit one statement from the file.
"""
import json
from datetime import date

import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.ratelimit import check_rate
from app.core.uploads import (
    CSV_MAX_BYTES,
    STATEMENT_MAX_BYTES,
    UPLOAD_RATE,
    read_capped,
    require_csv_rows,
)
from app.models.account import Account, CsvMapping
from app.models.transaction import Transaction
from app.models.user import User
from app.modules.accounts.categorizer import classify_transaction
from app.modules.accounts.ingest import insert_new_transactions
from app.modules.accounts.ingest import pair_transfers as _pair_transfers
from app.modules.accounts.csv_parser import (
    apply_corrections,
    delete_upload,
    load_upload,
    parse_and_map,
    parse_csv_preview,
    save_upload,
    validate_rows,
)
from app.modules.aggregator.csv_parsers import parse_csv_auto_with_institution, unreadable_rows
from app.modules.aggregator.ofx_parser import (
    OFXStatement,
    decode_ofx,
    looks_like_ofx,
    parse_ofx_statements,
)
from app.api.aggregator import _income_to_record
from app.modules.portfolio.valuation import DEBT_TYPES, INVESTMENT_TYPES

router = APIRouter(prefix="/api/imports", tags=["imports"])

log = structlog.get_logger()



class PreviewOut(BaseModel):
    upload_id: str
    columns: list[str]
    sample_rows: list[dict]
    encoding: str
    delimiter: str


class CommitBody(BaseModel):
    account_id: int
    column_map: dict[str, str]
    amount_debit_column: str | None = None
    amount_credit_column: str | None = None
    save_mapping: bool = True
    corrections: list[dict] = []  # [{"row_index": int, "fields": {canonical_field: value}}]


class CommitOut(BaseModel):
    imported: int
    skipped: int


class InvalidRowOut(BaseModel):
    row_index: int
    raw: dict
    partial: dict
    errors: dict[str, str]


class ValidateBody(BaseModel):
    account_id: int
    column_map: dict[str, str]
    amount_debit_column: str | None = None
    amount_credit_column: str | None = None


class ValidateOut(BaseModel):
    valid_count: int
    invalid_rows: list[InvalidRowOut]



@router.post("/csv", response_model=PreviewOut, status_code=status.HTTP_201_CREATED)
async def upload_csv(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),  # noqa: ARG001 — keep for auth consistency
):
    await check_rate(f"upload:import:{user.id}", max_calls=UPLOAD_RATE["import"])
    raw = await read_capped(file, CSV_MAX_BYTES, "A CSV file")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    require_csv_rows(raw)

    upload_id = await save_upload(user.id, raw)
    preview = parse_csv_preview(raw)
    return {"upload_id": upload_id, **preview}


@router.post("/csv/{upload_id}/validate", response_model=ValidateOut)
async def validate_csv(
    upload_id: str,
    body: ValidateBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Parse all rows and return valid count + invalid rows with per-field errors."""
    acct = await db.scalar(
        select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        raw = await load_upload(user.id, upload_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Upload not found or expired")

    result = validate_rows(
        raw,
        body.column_map,
        body.account_id,
        amount_debit_column=body.amount_debit_column,
        amount_credit_column=body.amount_credit_column,
    )
    return {
        "valid_count": len(result["valid"]),
        "invalid_rows": result["invalid"],
    }


@router.post("/csv/{upload_id}/commit", response_model=CommitOut)
async def commit_csv(
    upload_id: str,
    body: CommitBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify account belongs to user
    acct = await db.scalar(
        select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        raw = await load_upload(user.id, upload_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Upload not found or expired")

    if body.corrections:
        transactions, _ = apply_corrections(
            raw,
            body.column_map,
            body.account_id,
            body.corrections,
            amount_debit_column=body.amount_debit_column,
            amount_credit_column=body.amount_credit_column,
        )
    else:
        transactions = parse_and_map(
            raw,
            body.column_map,
            body.account_id,
            amount_debit_column=body.amount_debit_column,
            amount_credit_column=body.amount_credit_column,
        )

    if not transactions:
        await delete_upload(user.id, upload_id)
        return {"imported": 0, "skipped": 0}

    # Auto-categorize using transaction_type for debit=expense / credit=income fallback
    for txn in transactions:
        cat_id = await classify_transaction(
            txn["description"], txn["amount"], user.id, db,
            transaction_type=txn.get("transaction_type"),
            account_type=acct.account_type,
            bank_category=txn.get("bank_category"),
        )
        txn["category_id"] = cat_id

    for txn in transactions:
        txn["category_source"] = "auto"

    # One statement, arbitrated by the (account_id, external_id) unique index,
    # instead of a SELECT per row.
    imported, skipped, inserted_ids = await insert_new_transactions(db, transactions)

    # Persist column mapping for reuse
    if body.save_mapping and imported > 0:
        mapping_data = {
            "column_map": body.column_map,
            "amount_debit_column": body.amount_debit_column,
            "amount_credit_column": body.amount_credit_column,
        }
        existing_mapping = await db.scalar(
            select(CsvMapping).where(CsvMapping.account_id == body.account_id)
        )
        if existing_mapping:
            existing_mapping.mapping_json = json.dumps(mapping_data)
        else:
            db.add(CsvMapping(account_id=body.account_id, mapping_json=json.dumps(mapping_data)))

    # Store the running balance from the most-recent transaction (by date) if available.
    # This lets the breakdown show the actual account balance instead of summing amounts.
    if imported > 0:
        from app.models.transaction import Transaction as Txn
        latest_bal = await db.scalar(
            select(Txn.balance)
            .where(Txn.account_id == body.account_id, Txn.balance.is_not(None))
            .order_by(Txn.date_posted.desc(), Txn.id.desc())
            .limit(1)
        )
        if latest_bal is not None:
            acct.current_balance = float(latest_bal)

    await db.commit()
    # Paired only once the import is saved: a matcher failure rolls back its
    # own work, never the rows just imported.
    await _pair_transfers(db, user.id, inserted_ids)
    await delete_upload(user.id, upload_id)
    return {"imported": imported, "skipped": skipped}


@router.get("/csv/{account_id}/mapping")
async def get_saved_mapping(
    account_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    acct = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    mapping = await db.scalar(
        select(CsvMapping).where(CsvMapping.account_id == account_id)
    )
    if not mapping:
        return None
    return json.loads(mapping.mapping_json)


class BankImportOut(BaseModel):
    imported: int
    skipped: int
    institution: str
    balance_found: bool


class UnreadableRowOut(BaseModel):
    line: int
    values: list[str]
    reason: str


class BankImportPreviewOut(BaseModel):
    """What ``/bank-csv`` would do with this file, before anything is written."""
    institution: str
    #: Non-blank data rows in the file.
    row_count: int
    #: Rows it would add.
    new_count: int
    #: Rows the account already has (an earlier import of the same rows).
    duplicate_count: int
    #: Rows it cannot read, each with the reason.
    unreadable: list[UnreadableRowOut]
    date_from: str | None
    date_to: str | None
    #: The most recent rows it would add, newest first.
    sample: list[dict]
    balance_found: bool


@router.post("/bank-csv", response_model=BankImportOut | BankImportPreviewOut)
async def import_bank_csv(
    file: UploadFile = File(...),
    account_id: int = Form(...),
    preview: bool = Form(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Smart bank CSV import: auto-detect the institution format and import
    into the specified account. With ``preview`` it writes nothing and returns
    a ``BankImportPreviewOut``: the wizard shows that and imports on Confirm.
    Supports Chase, Citibank, Bank of America, American Express and Wells
    Fargo by name, and any other bank's CSV by its column names.
    Duplicate transactions (same account + content hash) are silently skipped.
    """
    # Verify account belongs to user
    acct = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    await check_rate(f"upload:import:{user.id}", max_calls=UPLOAD_RATE["import"])
    raw = await read_capped(file, CSV_MAX_BYTES, "A CSV file")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    require_csv_rows(raw)

    try:
        content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        content = raw.decode("latin-1", errors="replace")

    try:
        transactions, institution = parse_csv_auto_with_institution(content)
    except Exception as exc:
        log.error("import_bank_csv.parse_error", error=type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=422, detail=f"Could not parse CSV: {exc}")

    if not transactions:
        raise HTTPException(
            status_code=422,
            detail=(
                "No transactions found. Make sure the file is a CSV exported from your bank "
                "with date, amount, and description columns."
            ),
        )

    if preview:
        return await _preview_bank_csv(db, account_id, content, transactions, institution)

    imported = skipped = 0
    # Track balance from the most-recent transaction by date (handles both
    # newest-first and oldest-first CSVs).
    latest_balance: float | None = None
    latest_balance_date = None

    try:
        for txn in transactions:
            # Dedup check by content hash
            existing = await db.scalar(
                select(Transaction).where(
                    Transaction.account_id == account_id,
                    Transaction.external_id == txn.fitid,
                )
            )
            if existing:
                skipped += 1
                continue

            txn_type = "credit" if txn.amount >= 0 else "debit"
            cat_id = await classify_transaction(
                txn.name, txn.amount, user.id, db, transaction_type=txn_type,
                account_type=acct.account_type,
                bank_type=txn.trntype,
                bank_category=txn.bank_category,
            )
            balance = getattr(txn, "_balance", None)
            db.add(Transaction(
                account_id=account_id,
                date_posted=txn.date_posted,
                transaction_type=txn_type,
                description=txn.name or txn.memo,
                amount=txn.amount,
                balance=balance,
                member_name=txn.member_name or None,
                source="csv",
                external_id=txn.fitid,
                category_id=cat_id,
                category_source="auto",
                bank_category=txn.bank_category[:64] or None,
            ))
            imported += 1
            if balance is not None and (
                latest_balance_date is None or txn.date_posted > latest_balance_date
            ):
                latest_balance = balance
                latest_balance_date = txn.date_posted

        # Update account current_balance from the most-recent transaction's balance
        if latest_balance is not None:
            acct.current_balance = latest_balance

        await db.commit()
    except Exception as exc:
        # The class name only: a database error's text describes the rows
        # being written, which is the user's financial data.
        log.error("import_bank_csv.db_error", error=type(exc).__name__, exc_info=True)
        await db.rollback()
        raise HTTPException(
            status_code=500,
            detail="We could not save these transactions, so none were imported.",
        )

    return BankImportOut(
        imported=imported,
        skipped=skipped,
        institution=institution,
        balance_found=latest_balance is not None,
    )


async def _preview_bank_csv(
    db: AsyncSession, account_id: int, content: str, transactions: list, institution: str,
) -> BankImportPreviewOut:
    """The import's own decisions, row by row, without the writes."""
    have = set((await db.scalars(
        select(Transaction.external_id).where(
            Transaction.account_id == account_id,
            Transaction.external_id.in_([t.fitid for t in transactions]),
        )
    )).all())
    new, duplicates = [], 0
    for txn in transactions:
        if txn.fitid in have:
            duplicates += 1
        else:
            new.append(txn)

    row_count, unreadable = unreadable_rows(content)
    dates = [t.date_posted for t in transactions]
    newest = sorted(new, key=lambda t: t.date_posted, reverse=True)[:5]
    return BankImportPreviewOut(
        institution=institution,
        row_count=row_count,
        new_count=len(new),
        duplicate_count=duplicates,
        unreadable=[UnreadableRowOut(**r) for r in unreadable],
        date_from=min(dates).isoformat() if dates else None,
        date_to=max(dates).isoformat() if dates else None,
        sample=[
            {"date": t.date_posted.isoformat(), "description": t.name or t.memo or "",
             "amount": t.amount}
            for t in newest
        ],
        balance_found=any(getattr(t, "_balance", None) is not None for t in transactions),
    )


# ── OFX / QFX ────────────────────────────────────────────────────────────────
#
# The file a bank or card issuer offers as "Quicken" or "Money" download. It
# needs no column mapping: every row has a date, an amount, a payee and the
# institution's own id for it, so importing the same file twice adds nothing.
#
# Two calls, both carrying the file. Preview reads it and says what would
# happen; import does it. Nothing is kept on the server in between.


#: What a statement's kind says about the account it came from, for the hint
#: when someone points a card statement at a checking account.
_KIND_LABEL = {"bank": "bank account", "card": "credit card", "investment": "investment account"}


class OfxStatementOut(BaseModel):
    index: int
    kind: str
    #: As the file names it: CHECKING, SAVINGS, CREDITCARD, INVESTMENT…
    account_type: str | None
    #: Last four characters of the account number in the file, so the person
    #: can tell two statements apart. The full number is never returned.
    account_last4: str | None
    transaction_count: int
    new_count: int
    already_imported: int
    date_from: str | None
    date_to: str | None
    #: The statement balance as it would be stored on the account.
    balance: float | None
    balance_as_of: str | None
    #: Rows the file listed that had no date or no amount.
    unreadable: int
    #: Buys and sells, and positions, in an investment statement. Their cash
    #: movements are imported as transactions; holdings are not changed.
    trade_count: int
    position_count: int
    income_count: int
    #: Income rows the import would record: new ones on holdings kept by
    #: trades in an investment account. The rest change nothing.
    income_new: int = 0
    #: False when the statement's kind does not fit the chosen account.
    fits_account: bool
    sample: list[dict]


class OfxPreviewOut(BaseModel):
    statements: list[OfxStatementOut]
    #: The statement to offer first: the one that fits the account, with the
    #: most new rows.
    suggested_index: int | None


class OfxImportOut(BaseModel):
    imported: int
    skipped: int
    unreadable: int
    income_recorded: int
    balance_updated: bool
    #: Holdings created and updated from the statement's positions, and
    #: positions left alone because the user keeps that holding by trades.
    holdings_created: int = 0
    holdings_updated: int = 0
    holdings_kept: int = 0


async def _read_ofx(file: UploadFile, user_id: int) -> list[OFXStatement]:
    await check_rate(f"upload:import:{user_id}", max_calls=UPLOAD_RATE["import"])
    raw = await read_capped(file, STATEMENT_MAX_BYTES, "A statement file")
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if not looks_like_ofx(raw):
        raise HTTPException(
            status_code=422,
            detail="This is not an OFX or QFX file. Download the file your bank "
                   "offers for Quicken or Microsoft Money, or import a CSV file.",
        )
    statements = parse_ofx_statements(decode_ofx(raw))
    # A brokerage snapshot can hold positions or income with no cash rows; the
    # preview and import below handle that, so only a file with none of the
    # three is refused. It used to be refused for having no transactions
    # before that code could run.
    if not any(s.transactions or s.holdings or s.inv_income for s in statements):
        raise HTTPException(
            status_code=422, detail="This file has no transactions or positions to import."
        )
    return statements


async def _import_target(db: AsyncSession, user: User, account_id: int) -> Account:
    acct = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")
    return acct


def _fits(stmt: OFXStatement, acct: Account) -> bool:
    if stmt.kind == "card":
        return acct.account_type in DEBT_TYPES
    if stmt.kind == "investment":
        return acct.account_type in INVESTMENT_TYPES
    return acct.account_type not in INVESTMENT_TYPES and acct.account_type != "credit_card"


def _stored_balance(stmt: OFXStatement, acct: Account) -> float | None:
    """The statement balance in the sign this account keeps its balance in.

    A card or loan statement states money owed as a negative balance; Paiso
    keeps what is owed on a debt account as a positive number.
    """
    if stmt.ledger_balance is None:
        return None
    amount = stmt.ledger_balance.amount
    return -amount if acct.account_type in DEBT_TYPES else amount


def _cash_rows(stmt: OFXStatement):
    """The statement's rows that are cash in or out of the account.

    An investment statement's buys, sales and income are changes inside the
    account, which the positions already show: entered as cash, a $5,000 fund
    purchase counted as $5,000 of spending. Its deposits, withdrawals and fees
    (INVBANKTRAN) are cash and stay.
    """
    return [t for t in stmt.transactions if not t.investment]


def _ofx_rows(stmt: OFXStatement, account_id: int) -> list[dict]:
    return [
        {
            "account_id": account_id,
            "date_posted": t.date_posted,
            "transaction_type": "credit" if t.amount >= 0 else "debit",
            "description": t.name or t.memo or "Transaction",
            "amount": t.amount,
            "source": "csv",
            "external_id": t.fitid,
            "bank_category": None,
        }
        for t in _cash_rows(stmt)
    ]


@router.post("/ofx/preview", response_model=OfxPreviewOut)
async def preview_ofx(
    file: UploadFile = File(...),
    account_id: int = Form(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """What importing this file into this account would do. Writes nothing."""
    acct = await _import_target(db, user, account_id)
    statements = await _read_ofx(file, user.id)

    out: list[OfxStatementOut] = []
    for index, stmt in enumerate(statements):
        cash = _cash_rows(stmt)
        ids = {t.fitid for t in cash}
        existing = set((await db.scalars(
            select(Transaction.external_id).where(
                Transaction.account_id == account_id,
                Transaction.external_id.in_(ids),
            )
        )).all()) if ids else set()
        dates = [t.date_posted for t in cash]
        number = stmt.account.account_number if stmt.account else ""
        out.append(OfxStatementOut(
            index=index,
            kind=stmt.kind,
            account_type=stmt.account.account_type if stmt.account else None,
            account_last4=number[-4:] if len(number) >= 4 else None,
            transaction_count=len(ids),
            new_count=len(ids - existing),
            already_imported=len(ids & existing),
            date_from=min(dates).isoformat() if dates else None,
            date_to=max(dates).isoformat() if dates else None,
            balance=_stored_balance(stmt, acct),
            balance_as_of=(
                stmt.ledger_balance.as_of_date.isoformat()
                if stmt.ledger_balance and stmt.ledger_balance.as_of_date else None
            ),
            unreadable=stmt.unreadable,
            trade_count=stmt.trade_count,
            position_count=len(stmt.holdings),
            income_count=len(stmt.inv_income),
            income_new=(
                await _income_to_record(stmt.inv_income, account_id, db)
                if stmt.inv_income and acct.account_type in INVESTMENT_TYPES else 0
            ),
            fits_account=_fits(stmt, acct),
            sample=[
                {"date": t.date_posted.isoformat(), "description": t.name or t.memo, "amount": t.amount}
                for t in sorted(cash, key=lambda t: t.date_posted, reverse=True)[:5]
            ],
        ))

    # A statement with positions and no cash rows still has something to import.
    usable = [s for s in out if s.transaction_count or s.position_count or s.income_new]
    best = max(usable, key=lambda s: (s.fits_account, s.new_count), default=None)
    return OfxPreviewOut(statements=out, suggested_index=best.index if best else None)


@router.post("/ofx", response_model=OfxImportOut)
async def import_ofx(
    file: UploadFile = File(...),
    account_id: int = Form(...),
    statement_index: int = Form(0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Import one statement from an OFX or QFX file into the chosen account.

    Rows the account already has (same institution id) are skipped, so the
    same file, or two files whose dates overlap, can be imported freely.
    """
    acct = await _import_target(db, user, account_id)
    statements = await _read_ofx(file, user.id)
    if not 0 <= statement_index < len(statements):
        raise HTTPException(status_code=400, detail="That statement is not in the file.")
    stmt = statements[statement_index]
    rows = _ofx_rows(stmt, account_id)

    for row, t in zip(rows, _cash_rows(stmt)):
        row["category_id"] = await classify_transaction(
            row["description"], row["amount"], user.id, db,
            transaction_type=row["transaction_type"],
            account_type=acct.account_type,
            bank_type=t.trntype,
        )
        row["category_source"] = "auto"

    imported, skipped, inserted_ids = await insert_new_transactions(db, rows)

    # Dividends and reinvestments onto holdings kept by trades, then the
    # positions (app/api/aggregator.py). Only into an investment account: the
    # holdings need one to belong to.
    income_recorded = 0
    positions = None
    if acct.account_type in INVESTMENT_TYPES:
        from app.api.aggregator import _import_inv_income, _import_positions

        if stmt.inv_income:
            income_recorded, _ = await _import_inv_income(stmt.inv_income, account_id, db)
        if stmt.holdings:
            as_of = stmt.ledger_balance.as_of_date if stmt.ledger_balance else None
            positions = await _import_positions(stmt.holdings, account_id, db, as_of or date.today())

    # The statement balance is the institution's own figure. Take it unless
    # the account already has a newer one.
    balance = _stored_balance(stmt, acct)
    as_of = stmt.ledger_balance.as_of_date if stmt.ledger_balance else None
    balance_updated = False
    if balance is not None and not (acct.balance_as_of and as_of and as_of < acct.balance_as_of):
        acct.current_balance = balance
        if as_of:
            acct.balance_as_of = as_of
        balance_updated = True

    await db.commit()
    # After the commit, as in commit_csv.
    await _pair_transfers(db, user.id, inserted_ids)
    log.info("import_ofx.done", user_id=user.id, account_id=account_id,
             imported=imported, skipped=skipped, kind=stmt.kind)
    return OfxImportOut(
        imported=imported,
        skipped=skipped,
        unreadable=stmt.unreadable,
        income_recorded=income_recorded,
        balance_updated=balance_updated,
        holdings_created=positions.created if positions else 0,
        holdings_updated=positions.updated if positions else 0,
        holdings_kept=positions.kept if positions else 0,
    )

import re
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import String, and_, case, cast, func, not_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import contains_eager, selectinload

from app.api.deps import get_current_user, get_user_account_ids

from app.core.database import get_db
from app.core.validation import Money, TransactionDate
from app.core.ratelimit import check_rate
from app.core.storage import get_storage
from app.core.uploads import (
    RECEIPT_MAX_BYTES,
    RECEIPTS_PER_TRANSACTION,
    UPLOAD_RATE,
    check_storage_quota,
    read_capped,
    sniff_receipt,
)
from app.models.account import Account
from app.models.transaction import Category, Transaction, TransactionAttachment
from app.models.user import User
from app.modules.accounts.categorizer import FALLBACK_NAMES, classify_transaction, normalize_merchant

from app.modules.portfolio.valuation import CASH_TYPES, INVESTMENT_TYPES

router = APIRouter(prefix="/api/transactions", tags=["transactions"])

ACCOUNT_TYPE_GROUPS: dict[str, list[str]] = {
    "cash": sorted(CASH_TYPES),
    "investments": sorted(INVESTMENT_TYPES),
    "credit_cards": ["credit_card"],
    "loan": ["loan"],
    "mortgage": ["mortgage"],
}

VALID_SORT_FIELDS = {"date", "amount", "description", "account", "category"}

MAX_ATTACHMENT_BYTES = RECEIPT_MAX_BYTES
_RECEIPT_EXT = {
    "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp",
    "image/gif": ".gif", "image/heic": ".heic", "application/pdf": ".pdf",
}


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class TransactionOut(BaseModel):
    id: int
    account_id: int
    account_name: str | None
    date_posted: date
    description: str | None
    amount: float
    transaction_type: str | None
    balance: float | None
    category_id: int | None
    category_name: str | None
    notes: str | None
    tags: str | None
    member_name: str | None
    source: str | None
    is_duplicate: bool
    pending: bool
    merchant_name: str | None
    date_authorized: date | None
    transfer: dict | None = None

    model_config = {"from_attributes": True}


class TransactionUpdate(BaseModel):
    category_id: int | None = None
    notes: str | None = Field(None, max_length=5000)
    tags: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=2000)


class TransactionCreate(BaseModel):
    account_id: int
    date_posted: TransactionDate
    description: str = Field(min_length=1, max_length=2000)
    amount: Money
    transaction_type: str | None = None
    balance: Money | None = None
    category_id: int | None = None
    notes: str | None = Field(None, max_length=5000)
    tags: str | None = Field(None, max_length=500)


class MarkDuplicateBody(BaseModel):
    is_duplicate: bool


class BulkUpdateBody(BaseModel):
    transaction_ids: list[int] = Field(max_length=5000)
    category_id: int | None = None
    description: str | None = Field(None, max_length=2000)
    notes: str | None = Field(None, max_length=5000)


class PaginatedTransactions(BaseModel):
    items: list[TransactionOut]
    total: int
    total_amount: float
    page: int
    page_size: int


class AttachmentOut(BaseModel):
    id: int
    filename: str
    content_type: str | None
    size_bytes: int
    created_at: str


# ---------------------------------------------------------------------------
# Serializer helper
# ---------------------------------------------------------------------------

def _txn_out(txn: Transaction, transfer: dict | None = None) -> dict:
    return {
        "id": txn.id,
        "account_id": txn.account_id,
        "account_name": txn.account.display_name if txn.account else None,
        "date_posted": txn.date_posted,
        "description": txn.description or "",
        "amount": float(txn.amount),
        "transaction_type": txn.transaction_type,
        "balance": float(txn.balance) if txn.balance is not None else None,
        "category_id": txn.category_id,
        "category_name": txn.category.name if txn.category else None,
        "notes": txn.notes,
        "tags": txn.tags,
        "member_name": txn.member_name,
        "source": txn.source,
        "is_duplicate": bool(txn.is_duplicate),
        # Unsettled: shown in the ledger, excluded from every total.
        "pending": bool(txn.pending),
        "merchant_name": txn.merchant_name,
        "date_authorized": txn.date_authorized,
        # The other leg of this movement, when one has been paired.
        "transfer": transfer,
    }


async def _transfer_links_for(
    db: AsyncSession, transaction_ids: list[int]
) -> dict[int, dict]:
    """transaction id → its live transfer link, for the given rows."""
    if not transaction_ids:
        return {}
    from app.models.transfer import TransferLink

    rows = (await db.scalars(
        select(TransferLink).where(
            TransferLink.status != "rejected",
            or_(
                TransferLink.outflow_txn_id.in_(transaction_ids),
                TransferLink.inflow_txn_id.in_(transaction_ids),
            ),
        )
    )).all()
    if not rows:
        return {}

    # Resolve each counterpart in one go — account name, and enough of the row
    # itself for the drawer to show what this was paired with rather than only
    # that it was paired.
    counterpart_ids = {r.outflow_txn_id for r in rows} | {r.inflow_txn_id for r in rows}
    counterparts = {
        r.id: {
            "account_name": r.display_name,
            "date": r.date_posted.isoformat() if r.date_posted else None,
            "amount": float(r.amount) if r.amount is not None else None,
            "description": r.description,
        }
        for r in (await db.execute(
            select(
                Transaction.id, Account.display_name,
                Transaction.date_posted, Transaction.amount, Transaction.description,
            )
            .join(Account, Account.id == Transaction.account_id)
            .where(Transaction.id.in_(counterpart_ids))
        )).all()
    }

    out: dict[int, dict] = {}
    for link in rows:
        for side, other in ((link.outflow_txn_id, link.inflow_txn_id),
                            (link.inflow_txn_id, link.outflow_txn_id)):
            if side in transaction_ids:
                counterpart = counterparts.get(other) or {}
                out[side] = {
                    "link_id": link.id,
                    "status": link.status,
                    "kind": link.kind,
                    "confidence": float(link.confidence),
                    # Which signals matched, and whether a person or the matcher
                    # decided. A pair the matcher confirmed on its own is an
                    # automated recategorisation, and this is what lets someone
                    # see why before undoing it.
                    "matched_on": link.matched_on,
                    "source": link.source,
                    "counterpart_transaction_id": other,
                    "counterpart_account_name": counterpart.get("account_name"),
                    "counterpart_date": counterpart.get("date"),
                    "counterpart_amount": counterpart.get("amount"),
                    "counterpart_description": counterpart.get("description"),
                }
    return out


# ---------------------------------------------------------------------------
# Endpoints — specific paths declared before /{transaction_id}
# ---------------------------------------------------------------------------

#: Unsettled rows sort above everything else, whatever column the user picked.
#:
#: A pending charge is the one row in the ledger that is still moving — it is
#: what the reader is checking for, and it is the only row whose amount and
#: merchant may still change. Sorted by date like everything else it lands
#: wherever its authorization date falls, which on a descending date sort is
#: usually the top but on any other sort (amount, description, account, or an
#: ascending date) is somewhere in the middle of page four.
#:
#: `pending` is nullable, so this tests IS TRUE rather than truthiness: NULL
#: means "not pending" here and must sort with the settled rows.
_PENDING_FIRST = case((Transaction.pending.is_(True), 0), else_=1)


async def _transaction_filters(
    *,
    db: AsyncSession,
    user: User,
    user_account_ids: list[int],
    account_id: Optional[int],
    account_type_group: Optional[str],
    category_id: Optional[int],
    date_from: Optional[date],
    date_to: Optional[date],
    search: Optional[str],
    uncategorized: bool,
    exclude_transfers: bool,
    only_transfers: bool,
    only_pending: bool,
    exclude_pending: bool,
    amount_sign: Optional[str],
    exclude_loan_credits: bool = False,
) -> list:
    """WHERE clauses for the ledger's filters, shared by the list and the
    breakdown so a chart always describes exactly the rows in the table.

    Callers must join Account (the type-group filter reads it) and, when
    ``search`` is set, outer-join Category (search matches category names).
    """
    # --- Build base filter clauses --------------------------------------------
    filters: list = [Transaction.account_id.in_(user_account_ids)]

    if account_id is not None:
        if account_id not in user_account_ids:
            raise HTTPException(status_code=403, detail="Account not found")
        filters.append(Transaction.account_id == account_id)

    if account_type_group == "mortgage":
        # Mortgage: own mortgage accounts, OR transactions matching a
        # mortgage's description_pattern.
        mortgage_accts = (await db.scalars(
            select(Account).where(
                Account.user_id == user.id,
                Account.account_type == "mortgage",
            )
        )).all()
        patterns = [a.description_pattern for a in mortgage_accts if a.description_pattern]
        mortgage_filter = [
            Account.account_type == "mortgage",
        ]
        for pat in patterns:
            # autoescape: an older pattern may hold % or _.
            mortgage_filter.append(Transaction.description.icontains(pat, autoescape=True))
        filters.append(or_(*mortgage_filter))
    elif account_type_group and account_type_group in ACCOUNT_TYPE_GROUPS:
        filters.append(Account.account_type.in_(ACCOUNT_TYPE_GROUPS[account_type_group]))

    if category_id is not None:
        filters.append(Transaction.category_id == category_id)

    if date_from:
        filters.append(Transaction.date_posted >= date_from)

    if date_to:
        filters.append(Transaction.date_posted <= date_to)

    if search:
        def _term_clause(word: str):
            """Return an OR-of-fields ILIKE clause for a single word."""
            t = f"%{word}%"
            return or_(
                Transaction.description.ilike(t),
                Transaction.notes.ilike(t),
                Account.display_name.ilike(t),
                Category.name.ilike(t),
                Transaction.member_name.ilike(t),
                cast(Transaction.date_posted, String).ilike(t),
                # US-format date text search.
                func.strftime("%m/%d/%Y", Transaction.date_posted).ilike(t),
                cast(Transaction.amount, String).ilike(t),
            )

        # Parse AND / OR / NOT boolean operators (case-insensitive).
        # OR groups are split first (lowest precedence); within each group
        # tokens are ANDed; a leading NOT negates the next token.
        or_groups = re.split(r"\bOR\b", search, flags=re.IGNORECASE)
        or_clauses = []
        for group in or_groups:
            tokens = group.strip().split()
            and_clauses: list = []
            negate = False
            for token in tokens:
                if re.fullmatch(r"AND", token, re.IGNORECASE):
                    continue
                if re.fullmatch(r"NOT", token, re.IGNORECASE):
                    negate = True
                    continue
                clause = _term_clause(token)
                and_clauses.append(not_(clause) if negate else clause)
                negate = False
            if and_clauses:
                or_clauses.append(and_(*and_clauses) if len(and_clauses) > 1 else and_clauses[0])
        if or_clauses:
            filters.append(or_(*or_clauses) if len(or_clauses) > 1 else or_clauses[0])

    if uncategorized:
        filters.append(Transaction.category_id.is_(None))

    if exclude_loan_credits:
        # The budget's view of a category: no payments received on a loan's
        # own ledger, as budgets count it.
        from app.modules.budgeting.aggregates import _NOT_LOAN_CREDIT
        filters.append(_NOT_LOAN_CREDIT)

    if amount_sign == "positive":
        filters.append(Transaction.amount > 0)
    elif amount_sign == "negative":
        filters.append(Transaction.amount < 0)
    elif amount_sign in ("income", "spending"):
        # The rows the Income and Expenses tabs total: a refund (money in
        # under an expense category) nets against spending, never income.
        refund = and_(
            Transaction.amount > 0,
            Transaction.category_id.is_not(None),  # false, not NULL, when uncategorized
            Transaction.category_id.in_(select(Category.id).where(Category.treatment == "expense")),
        )
        filters.append(
            and_(Transaction.amount > 0, not_(refund)) if amount_sign == "income"
            else or_(Transaction.amount < 0, refund)
        )

    # --- Transfer inclusion / exclusion ---------------------------------------
    # Transfers are net-worth-neutral categories (treatment='transfer').
    #   exclude_transfers → drop them from the rows, count AND sum so the table
    #                       is internally consistent and matches the page total.
    #   only_transfers    → show *only* them (the de-emphasized "Transfers &
    #                       Payments" section on the Income/Expense pages).
    # Classification is by treatment, not name, so renames never change the math.
    if only_pending:
        filters.append(Transaction.pending.is_(True))
    elif exclude_pending:
        # is_not(True) rather than == False: rows predating the column are NULL.
        filters.append(Transaction.pending.is_not(True))

    if exclude_transfers or only_transfers:
        transfer_ids_subq = (
            select(Category.id)
            .where(Category.user_id == user.id, Category.treatment == "transfer")
            .scalar_subquery()
        )
        if only_transfers:
            filters.append(Transaction.category_id.in_(transfer_ids_subq))
        else:
            filters.append(or_(
                Transaction.category_id.is_(None),
                Transaction.category_id.notin_(transfer_ids_subq),
            ))

    return filters


@router.get("", response_model=PaginatedTransactions)
async def list_transactions(
    account_id: Optional[int] = Query(None),
    account_type_group: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    search: Optional[str] = Query(None, max_length=500),
    uncategorized: bool = Query(False),
    exclude_transfers: bool = Query(False),
    only_transfers: bool = Query(False),
    # Unsettled rows are shown by default so the ledger matches the bank's own
    # app; these let the UI isolate or hide them.
    only_pending: bool = Query(False),
    exclude_pending: bool = Query(False),
    amount_sign: Optional[str] = Query(None),  # "positive", "negative", "income" or "spending"
    exclude_loan_credits: bool = Query(False),
    sort_by: str = Query("date"),
    sort_order: str = Query("desc"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=5000),
    fetch_all: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    if sort_by not in VALID_SORT_FIELDS:
        sort_by = "date"
    if sort_order not in ("asc", "desc"):
        sort_order = "desc"

    filters = await _transaction_filters(
        db=db, user=user, user_account_ids=user_account_ids,
        account_id=account_id, account_type_group=account_type_group,
        category_id=category_id, date_from=date_from, date_to=date_to,
        search=search, uncategorized=uncategorized,
        exclude_transfers=exclude_transfers, only_transfers=only_transfers,
        only_pending=only_pending, exclude_pending=exclude_pending,
        amount_sign=amount_sign, exclude_loan_credits=exclude_loan_credits,
    )

    where_clause = and_(*filters)
    sum_where = where_clause

    # --- Count & sum ----------------------------------------------------------
    # Both count and sum need Account join (for account_type_group filter).
    # Both may also need Category outerjoin (for search on category name).
    needs_cat_join = bool(search)

    count_q = (
        select(func.count(Transaction.id))
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(where_clause)
    )
    sum_q = (
        select(func.coalesce(func.sum(Transaction.amount), 0.0))
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(sum_where)
    )
    if needs_cat_join:
        count_q = count_q.outerjoin(Category, Transaction.category_id == Category.id)
        sum_q = sum_q.outerjoin(Category, Transaction.category_id == Category.id)
        # Transfer filtering uses a scalar subquery — no Category join required.

    total = (await db.scalar(count_q)) or 0
    total_amount = float((await db.scalar(sum_q)) or 0.0)

    # --- Main rows query ------------------------------------------------------
    if sort_by == "category" or needs_cat_join:
        main_q = (
            select(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .outerjoin(Category, Transaction.category_id == Category.id)
            .where(where_clause)
            .options(
                contains_eager(Transaction.account),
                contains_eager(Transaction.category),
            )
        )
        if sort_by == "category":
            if sort_order == "asc":
                main_q = main_q.order_by(
                    _PENDING_FIRST,
                    Category.name.asc().nulls_last(), Transaction.date_posted.desc()
                )
            else:
                main_q = main_q.order_by(
                    _PENDING_FIRST,
                    Category.name.desc().nulls_last(), Transaction.date_posted.desc()
                )
        else:
            main_q = main_q.order_by(
                _PENDING_FIRST, Transaction.date_posted.desc(), Transaction.id.desc()
            )
    else:
        main_q = (
            select(Transaction)
            .join(Account, Transaction.account_id == Account.id)
            .where(where_clause)
            .options(
                contains_eager(Transaction.account),
                selectinload(Transaction.category),
            )
        )

    if sort_by != "category":
        if sort_by == "amount":
            order = Transaction.amount.asc() if sort_order == "asc" else Transaction.amount.desc()
            main_q = main_q.order_by(_PENDING_FIRST, order, Transaction.date_posted.desc())
        elif sort_by == "description":
            order = (
                Transaction.description.asc().nulls_last()
                if sort_order == "asc"
                else Transaction.description.desc().nulls_last()
            )
            main_q = main_q.order_by(_PENDING_FIRST, order, Transaction.date_posted.desc())
        elif sort_by == "account":
            order = (
                Account.display_name.asc() if sort_order == "asc" else Account.display_name.desc()
            )
            main_q = main_q.order_by(_PENDING_FIRST, order, Transaction.date_posted.desc())
        elif sort_by != "category":  # default: date
            if sort_order == "asc":
                main_q = main_q.order_by(
                    _PENDING_FIRST, Transaction.date_posted.asc(), Transaction.id.asc()
                )
            else:
                main_q = main_q.order_by(
                    _PENDING_FIRST, Transaction.date_posted.desc(), Transaction.id.desc()
                )

    if not fetch_all:
        main_q = main_q.offset((page - 1) * page_size).limit(page_size)

    rows = (await db.scalars(main_q)).all()

    # Attach transfer pairing for just this page, in one query, so a row can
    # show "paid from Chase Checking" without an N+1.
    links = await _transfer_links_for(db, [t.id for t in rows])

    return {
        "items": [_txn_out(t, links.get(t.id)) for t in rows],
        "total": total,
        "total_amount": total_amount,
        "page": page,
        "page_size": total if fetch_all else page_size,
    }


#: Display order and labels for the breakdown's account-type groups.
_TYPE_GROUP_LABELS: dict[str, str] = {
    "cash": "Cash & Bank",
    "credit_cards": "Credit Cards",
    "investments": "Investments",
    "loan": "Loans",
    "mortgage": "Mortgages",
    "other": "Other",
}
_TYPE_TO_GROUP: dict[str, str] = {
    t: group for group, types in ACCOUNT_TYPE_GROUPS.items() for t in types
}


@router.get("/breakdown")
async def transaction_breakdown(
    group_by: str = Query("type_group", pattern="^(type_group|account)$"),
    account_id: Optional[int] = Query(None),
    account_type_group: Optional[str] = Query(None),
    category_id: Optional[int] = Query(None),
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    search: Optional[str] = Query(None, max_length=500),
    uncategorized: bool = Query(False),
    exclude_transfers: bool = Query(False),
    only_transfers: bool = Query(False),
    only_pending: bool = Query(False),
    exclude_pending: bool = Query(False),
    amount_sign: Optional[str] = Query(None),
    exclude_loan_credits: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    """How the transactions matching the ledger's filters split across account
    types (``type_group``) or individual accounts (``account``): count, money
    in, money out. Takes the list endpoint's filters, so the
    charts above the table always describe the same rows.
    """
    filters = await _transaction_filters(
        db=db, user=user, user_account_ids=user_account_ids,
        account_id=account_id, account_type_group=account_type_group,
        category_id=category_id, date_from=date_from, date_to=date_to,
        search=search, uncategorized=uncategorized,
        exclude_transfers=exclude_transfers, only_transfers=only_transfers,
        only_pending=only_pending, exclude_pending=exclude_pending,
        amount_sign=amount_sign, exclude_loan_credits=exclude_loan_credits,
    )
    q = (
        select(
            Account.id,
            Account.display_name,
            Account.account_type,
            func.count(Transaction.id),
            func.coalesce(func.sum(case((Transaction.amount > 0, Transaction.amount), else_=0)), 0),
            func.coalesce(func.sum(case((Transaction.amount < 0, Transaction.amount), else_=0)), 0),
        )
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(and_(*filters))
        .group_by(Account.id, Account.display_name, Account.account_type)
    )
    if search:
        q = q.outerjoin(Category, Transaction.category_id == Category.id)

    groups: dict[str, dict] = {}
    for acct_id, name, acct_type, count, inflow, outflow in (await db.execute(q)).all():
        if group_by == "account":
            key, label = str(acct_id), name or "Account"
        else:
            key = _TYPE_TO_GROUP.get(acct_type or "", "other")
            label = _TYPE_GROUP_LABELS[key]
        g = groups.setdefault(key, {
            "key": key, "label": label, "account_type": acct_type if group_by == "account" else None,
            "count": 0, "inflow": 0.0, "outflow": 0.0,
        })
        g["count"] += int(count or 0)
        g["inflow"] += float(inflow or 0)
        g["outflow"] += abs(float(outflow or 0))

    rows = sorted(groups.values(), key=lambda g: (-g["count"], g["label"]))
    for g in rows:
        g["inflow"] = round(g["inflow"], 2)
        g["outflow"] = round(g["outflow"], 2)
        g["net"] = round(g["inflow"] - g["outflow"], 2)
    out = {
        "group_by": group_by,
        "total_count": sum(g["count"] for g in rows),
        "total_inflow": round(sum(g["inflow"] for g in rows), 2),
        "total_outflow": round(sum(g["outflow"] for g in rows), 2),
        "groups": rows,
    }
    if account_type_group in _DEBT_GROUPS:
        out["debt"] = await _debt_totals(
            db, filters, search, account_type_group,
            user=user, account_id=account_id, date_from=date_from, date_to=date_to,
        )
    return out


#: Tabs whose accounts are debts, where "money in" and "money out" mean
#: paying the debt down and adding to it.
_DEBT_GROUPS = {"credit_cards", "loan", "mortgage"}
#: Tabs whose payments are split into principal and interest.
_SPLIT_GROUPS = {"loan", "mortgage"}
#: How far apart, in days, a bank's payment and the lender's credit for it
#: may post and still be read as the same payment.
_PAYMENT_MATCH_DAYS = 5


def _matching_credits(credits: list[tuple[date, float]], posted: date, amount: float) -> list[int] | None:
    """The lender credits that are this bank payment, by index: one of the
    same amount, or two or three posted together that add up to it, as a
    mortgage payment of $3,200.00 arrives as $3,150.00 plus $50 toward
    principal. None when nothing matches."""
    near = [i for i, (d, _a) in enumerate(credits) if abs((d - posted).days) <= _PAYMENT_MATCH_DAYS]
    for i in near:
        if abs(credits[i][1] - amount) < 0.005:
            return [i]
    from itertools import combinations

    for size in (2, 3):
        for combo in combinations(near, size):
            days = {credits[i][0] for i in combo}
            if max(days) - min(days) > timedelta(days=1):
                continue
            if abs(sum(credits[i][1] for i in combo) - amount) < 0.005:
                return list(combo)
    return None

async def _debt_totals(
    db: AsyncSession,
    filters: list,
    search: Optional[str],
    group: str,
    *,
    user: User,
    account_id: Optional[int],
    date_from: Optional[date],
    date_to: Optional[date],
) -> dict:
    """What the Loan and Mortgage tabs total instead of money in and out.

    The Mortgage tab lists both sides of a payment: the lender's credit on the
    mortgage account (money in) and the bank's payment out of checking (money
    out). Summed as in and out they cancel into a meaningless net. So,
    reading each row from the debt's side:

    - on the debt account, a credit is ``paid`` and a debit (interest, fees,
      escrow disbursements) is ``charged``;
    - a payment out of another account is ``paid`` too, unless the debt
      account has the lender's credit for the same amount within
      ``_PAYMENT_MATCH_DAYS`` days, when it is ``matched`` and not counted
      again.

    On the Loan and Mortgage tabs, ``split`` then divides what was paid into
    principal, interest and the rest (``debt_split.split_debt_payments``).
    """
    debt_types = set(ACCOUNT_TYPE_GROUPS[group])
    q = (
        select(Account.id, Account.account_type, Transaction.date_posted, Transaction.amount)
        .select_from(Transaction)
        .join(Account, Transaction.account_id == Account.id)
        .where(and_(*filters))
    )
    if search:
        q = q.outerjoin(Category, Transaction.category_id == Category.id)
    paid = charged = unmatched = 0.0
    paid_by_account: dict[int, float] = {}
    credits: list[tuple[date, float]] = []
    payer_side: list[tuple[date, float]] = []
    for acct_id, acct_type, posted, amount in (await db.execute(q)).all():
        amt = float(amount or 0)
        if acct_type in debt_types:
            if amt > 0:
                paid += amt
                paid_by_account[acct_id] = paid_by_account.get(acct_id, 0.0) + amt
                credits.append((posted, amt))
            else:
                charged += -amt
        elif amt < 0:
            payer_side.append((posted, -amt))
        # A credit into checking on this tab (a refund of an overpayment, say)
        # changes nothing owed and is left out.

    matched = 0
    unused = sorted(credits)
    for posted, amt in payer_side:
        hit = _matching_credits(unused, posted, amt)
        if hit is None:
            paid += amt
            unmatched += amt
        else:
            for i in sorted(hit, reverse=True):
                unused.pop(i)
            matched += 1
    out = {
        "paid": round(paid, 2),
        "charged": round(charged, 2),
        "net_paid": round(paid - charged, 2),
        "matched_payments": matched,
    }
    if group in _SPLIT_GROUPS:
        from app.modules.portfolio.debt_split import split_debt_payments

        q = select(Account).where(Account.user_id == user.id, Account.account_type.in_(debt_types))
        if account_id is not None:
            q = q.where(Account.id == account_id)
        accounts = list((await db.scalars(q)).all())
        out["split"] = await split_debt_payments(
            db, user.id, accounts, paid_by_account, unmatched, date_from, date_to,
        )
    return out


@router.post("", response_model=TransactionOut, status_code=status.HTTP_201_CREATED)
async def create_transaction(
    body: TransactionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    acct = await db.scalar(
        select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    if body.category_id is not None:
        cat = await db.scalar(
            select(Category).where(Category.id == body.category_id, Category.user_id == user.id)
        )
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")

    data = body.model_dump()
    # Auto-categorize manual entries the same way imports do when the user
    # didn't pick a category themselves.
    if data.get("category_id") is None:
        txn_type = body.transaction_type or ("credit" if body.amount >= 0 else "debit")
        data["category_id"] = await classify_transaction(
            body.description, body.amount, user.id, db, transaction_type=txn_type,
            account_type=acct.account_type,
        )
        data["category_source"] = "auto"
    else:
        data["category_source"] = "user"

    txn = Transaction(source="manual", external_id=None, **data)
    db.add(txn)
    await db.commit()
    await db.refresh(txn, ["account", "category"])
    return _txn_out(txn)


# --- Bulk update (before /{id} routes) ----------------------------------------

@router.post("/bulk-update")
async def bulk_update_transactions(
    body: BulkUpdateBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    if not body.transaction_ids:
        return {"updated": 0}
    # The category must be the user's own, as for a single edit.
    if body.category_id is not None and not await db.scalar(
        select(Category.id).where(Category.id == body.category_id, Category.user_id == user.id)
    ):
        raise HTTPException(status_code=404, detail="Category not found")

    rows = (await db.scalars(
        select(Transaction).where(
            Transaction.id.in_(body.transaction_ids),
            Transaction.account_id.in_(user_account_ids),
        )
    )).all()

    update_data = {
        k: v for k, v in body.model_dump(exclude_unset=True).items()
        if k != "transaction_ids"
    }
    for txn in rows:
        for field, value in update_data.items():
            if value is not None:
                setattr(txn, field, value)
        if update_data.get("category_id") is not None:
            txn.category_source = "user"

    await db.commit()
    return {"updated": len(rows)}


# --- Re-categorize (backfill) --------------------------------------------------

@router.post("/recategorize")
async def recategorize_transactions(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    """Re-run the categorization pipeline over transactions the user hasn't
    meaningfully categorized — those with no category or sitting in the generic
    fallback buckets (Other Income / Other Expenses / Uncategorized). User-placed
    categories are left untouched."""
    if not user_account_ids:
        return {"updated": 0}

    fallback_ids = set((await db.scalars(
        select(Category.id).where(
            Category.user_id == user.id,
            func.lower(Category.name).in_([n.lower() for n in FALLBACK_NAMES]),
        )
    )).all())

    target = Transaction.category_id.is_(None)
    if fallback_ids:
        target = or_(target, Transaction.category_id.in_(fallback_ids))

    rows = (await db.scalars(
        select(Transaction).where(
            Transaction.account_id.in_(user_account_ids),
            target,
            # "Other Expenses" chosen by hand stays.
            or_(Transaction.category_source.is_(None), Transaction.category_source != "user"),
        )
    )).all()
    account_types = dict((await db.execute(
        select(Account.id, Account.account_type).where(Account.id.in_(user_account_ids))
    )).all())

    updated = 0
    for txn in rows:
        txn_type = txn.transaction_type or (
            "credit" if float(txn.amount) >= 0 else "debit"
        )
        # The stored bank label lets a row imported before a map change land.
        new_cat = await classify_transaction(
            txn.description or "", float(txn.amount), user.id, db, transaction_type=txn_type,
            account_type=account_types.get(txn.account_id),
            bank_category=txn.bank_category,
        )
        if new_cat is not None and new_cat != txn.category_id:
            txn.category_id = new_cat
            updated += 1

    await db.commit()
    return {"updated": updated}


# --- Similar transactions ------------------------------------------------------

@router.get("/{transaction_id}/similar")
async def find_similar(
    transaction_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # The merchant key history learning uses, so "similar" means the same
    # thing in both places. Comparing the first 30 characters missed rent paid
    # by Zelle or ACH, whose reference code sits mid-description.
    key = normalize_merchant(txn.description or "")
    if not key:
        return {"count": 0, "ids": [], "transactions": []}

    query = (
        select(Transaction, Account.display_name, Category.name)
        .join(Account, Transaction.account_id == Account.id)
        .outerjoin(Category, Transaction.category_id == Category.id)
        .where(
            Transaction.account_id.in_(user_account_ids),
            Transaction.id != transaction_id,
        )
        .order_by(Transaction.date_posted.desc(), Transaction.id.desc())
    )
    # Narrow in SQL on the longest word. "H-E-B" has none of 3 letters, so
    # its rows are all compared in Python.
    anchor = max(key.split(" "), key=len)
    if len(anchor) >= 3:
        query = query.where(Transaction.description.ilike(f"%{anchor}%"))
    candidates = (await db.execute(query)).all()
    matches = [
        (t, account_name, category_name) for t, account_name, category_name in candidates
        if normalize_merchant(t.description or "") == key
    ]

    # Each match in full, newest first, so the drawer can list them and the
    # user can pick which ones a change applies to.
    return {
        "count": len(matches),
        "ids": [t.id for t, _, _ in matches],
        "transactions": [
            {
                "id": t.id,
                "date_posted": t.date_posted.isoformat(),
                "description": t.description,
                "amount": float(t.amount),
                "account_name": account_name,
                "category_id": t.category_id,
                "category_name": category_name,
            }
            for t, account_name, category_name in matches
        ],
    }


# --- Attachment endpoints (before /{transaction_id} generic routes) -----------

def _att_key(user_id: int, txn_id: int, stored_name: str) -> str:
    from app.modules.maintenance.files import attachment_key

    return attachment_key(user_id, txn_id, stored_name)


def _att_out(att: TransactionAttachment) -> dict:
    return {
        "id": att.id,
        "filename": att.filename,
        "content_type": att.content_type,
        "size_bytes": att.size_bytes,
        "created_at": att.created_at.isoformat(),
    }


def _clean_filename(name: str | None) -> str:
    """The base name of an uploaded file, without control characters or
    quotes, cut to 200 characters. It is shown in the drawer and sent back in
    the download header."""
    base = Path(name or "").name
    return re.sub(r'[\x00-\x1f\x7f"\\]', "", base)[:200].strip()


def _attachment_disposition(filename: str) -> str:
    """A Content-Disposition header that a stored name cannot break out of:
    an ASCII fallback, and the real name percent-encoded (RFC 6266)."""
    from urllib.parse import quote

    clean = _clean_filename(filename) or "attachment"
    ascii_name = clean.encode("ascii", "replace").decode().replace("?", "_")
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(clean)}"


@router.get("/{transaction_id}/attachments", response_model=list[AttachmentOut])
async def list_attachments(
    transaction_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    atts = (await db.scalars(
        select(TransactionAttachment)
        .where(
            TransactionAttachment.transaction_id == transaction_id,
            TransactionAttachment.user_id == user.id,
        )
        .order_by(TransactionAttachment.created_at.asc())
    )).all()
    return [_att_out(a) for a in atts]


@router.post("/{transaction_id}/attachments", response_model=AttachmentOut, status_code=201)
async def upload_attachment(
    transaction_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    await check_rate(f"upload:receipt:{user.id}", max_calls=UPLOAD_RATE["receipt"])
    held = await db.scalar(
        select(func.count()).select_from(TransactionAttachment).where(
            TransactionAttachment.transaction_id == transaction_id,
            TransactionAttachment.user_id == user.id,
        )
    )
    if held >= RECEIPTS_PER_TRANSACTION:
        raise HTTPException(
            status_code=400,
            detail=f"A transaction can hold up to {RECEIPTS_PER_TRANSACTION} attachments. "
                   "Delete one to add another.",
        )
    contents = await read_capped(file, MAX_ATTACHMENT_BYTES, "Each attachment")
    # Receipts are images or PDFs, decided by the bytes, not the browser's
    # label or the file name.
    content_type = sniff_receipt(contents)
    if content_type is None:
        raise HTTPException(
            status_code=400, detail="Attach a photo (PNG, JPEG, WebP, GIF or HEIC) or a PDF.",
        )
    await check_storage_quota(db, user.id, len(contents))

    stored_name = f"{uuid.uuid4().hex}{_RECEIPT_EXT[content_type]}"
    await get_storage().put(_att_key(user.id, transaction_id, stored_name), contents)

    att = TransactionAttachment(
        transaction_id=transaction_id,
        user_id=user.id,
        filename=_clean_filename(file.filename) or stored_name,
        stored_name=stored_name,
        content_type=content_type,
        size_bytes=len(contents),
    )
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return _att_out(att)


@router.get("/{transaction_id}/attachments/{att_id}/download")
async def download_attachment(
    transaction_id: int,
    att_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    att = await db.scalar(
        select(TransactionAttachment).where(
            TransactionAttachment.id == att_id,
            TransactionAttachment.transaction_id == transaction_id,
            TransactionAttachment.user_id == user.id,
        )
    )
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")

    data = await get_storage().get(_att_key(user.id, transaction_id, att.stored_name))
    if data is None:
        raise HTTPException(status_code=404, detail="File not found in storage")

    return Response(
        content=data,
        # A type the server checked; older files carry the
        # browser's label, so they go out as plain bytes.
        media_type=att.content_type if att.content_type in _RECEIPT_EXT else "application/octet-stream",
        headers={"Content-Disposition": _attachment_disposition(att.filename)},
    )


@router.delete("/{transaction_id}/attachments/{att_id}", status_code=204)
async def delete_attachment(
    transaction_id: int,
    att_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    att = await db.scalar(
        select(TransactionAttachment).where(
            TransactionAttachment.id == att_id,
            TransactionAttachment.transaction_id == transaction_id,
            TransactionAttachment.user_id == user.id,
        )
    )
    if not att:
        raise HTTPException(status_code=404, detail="Attachment not found")

    await get_storage().delete(_att_key(user.id, transaction_id, att.stored_name))

    await db.delete(att)
    await db.commit()


# --- Per-transaction CRUD -----------------------------------------------------

@router.patch("/{transaction_id}/duplicate", response_model=TransactionOut)
async def mark_duplicate(
    transaction_id: int,
    body: MarkDuplicateBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction)
        .where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
        .options(selectinload(Transaction.account), selectinload(Transaction.category))
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    txn.is_duplicate = body.is_duplicate
    await db.commit()
    await db.refresh(txn, ["account", "category"])
    return _txn_out(txn)


@router.patch("/{transaction_id}", response_model=TransactionOut)
async def update_transaction(
    transaction_id: int,
    body: TransactionUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction)
        .where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
        .options(selectinload(Transaction.account), selectinload(Transaction.category))
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    if body.category_id is not None:
        cat = await db.scalar(
            select(Category).where(Category.id == body.category_id, Category.user_id == user.id)
        )
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")

    updates = body.model_dump(exclude_unset=True)
    for field, value in updates.items():
        setattr(txn, field, value)
    if "category_id" in updates:
        # Marks this as the user's own choice, so no later automatic pass
        # (transfer pairing, recategorize) overwrites it.
        txn.category_source = "user"

    await db.commit()
    await db.refresh(txn, ["account", "category"])
    return _txn_out(txn)


@router.delete("/{transaction_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_transaction(
    transaction_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    txn = await db.scalar(
        select(Transaction).where(
            Transaction.id == transaction_id,
            Transaction.account_id.in_(user_account_ids),
        )
    )
    if not txn:
        raise HTTPException(status_code=404, detail="Transaction not found")

    # The attachment rows go with the transaction (ORM cascade); their files
    # did not, and stayed on disk outside the quota.
    from app.modules.maintenance.files import delete_attachment_files

    await delete_attachment_files(db, [txn.id])
    await db.delete(txn)
    await db.commit()

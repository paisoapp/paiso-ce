from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.validation import (
    AccountName, DescriptionPattern, Money, NonNegativeMoney, PastDate, Percent, ReasonableDate,
    TermMonths,
)
from app.models.account import ACCOUNT_TYPES, Account, Institution
from app.modules.accounts import classification
from app.modules.portfolio.balance_history import record_balance
from app.modules.portfolio.linked_loans import release_linked_property, sync_linked_loan
from app.modules.portfolio.valuation import DEBT_TYPES, INVESTMENT_TYPES
from app.models.user import User


router = APIRouter(prefix="/api/accounts", tags=["accounts"])

class AccountCreate(BaseModel):
    display_name: AccountName
    account_type: str
    institution_name: str | None = None
    currency: str = "USD"
    current_balance: Money | None = None
    credit_limit: NonNegativeMoney | None = None
    description_pattern: DescriptionPattern = None
    #: For an investment account: what it is for (investing, retirement,
    #: education, health) and its sub-type ("403B"). Together they decide
    #: account_type.
    investment_type: str | None = None
    subtype: str | None = None


class AccountUpdate(BaseModel):
    display_name: AccountName | None = None
    currency: str | None = None
    account_type: str | None = None
    institution_name: str | None = None
    current_balance: Money | None = None
    credit_limit: NonNegativeMoney | None = None
    description_pattern: DescriptionPattern = None
    investment_type: str | None = None
    subtype: str | None = None
    #: What a hand-kept plan holds beyond its tickers. A new value keeps the
    #: old one as the previous value, for the change shown beside it.
    other_funds_value: NonNegativeMoney | None = None
    contributions_total: NonNegativeMoney | None = None
    #: HSA coverage: "self" or "family".
    hsa_coverage: str | None = None
    #: Leave the account out of every total (one valued as a single number).
    exclude_from_net_worth: bool | None = None


class AccountOut(BaseModel):
    id: int
    display_name: str
    account_type: str
    currency: str
    institution_name: str | None
    current_balance: float | None
    balance_as_of: date | None
    credit_limit: float | None
    linked_asset_id: int | None
    description_pattern: str | None
    #: APR / statement / payment detail for cards, loans and mortgages.
    liability: dict | None = None
    #: What the account is (classification.describe): its investment type
    #: (the tab it is on), its sub-type, and the tax treatment that follows.
    investment_type: str | None = None
    investment_type_label: str | None = None
    subtype: str | None = None
    subtype_label: str | None = None
    tax_treatment: str | None = None
    tax_treatment_label: str | None = None
    classification_set_by_user: bool = False
    purpose: str | None = None
    purpose_label: str | None = None
    other_funds_value: float | None = None
    other_funds_as_of: date | None = None
    other_funds_prev_value: float | None = None
    contributions_total: float | None = None
    hsa_coverage: str | None = None
    exclude_from_net_worth: bool = False

    model_config = {"from_attributes": True}


def _balance_out(acct: Account) -> dict:
    """The balance a card shows. A hand-kept mortgage made with its property
    keeps no balance of its own: what is owed lives on the property's loan,
    so that is shown, dated today. It used to read "—", "Updated —".
    Only the response carries it; net worth still counts the debt once,
    through the property."""
    if acct.current_balance is not None:
        return {
            "current_balance": float(acct.current_balance),
            "balance_as_of": acct.balance_as_of.isoformat() if acct.balance_as_of else None,
        }
    owed = getattr(acct, "_loan_balance", None)
    if owed is not None:
        return {"current_balance": owed, "balance_as_of": date.today().isoformat()}
    return {"current_balance": None, "balance_as_of": None}


async def _attach_loan_balances(db: AsyncSession, accounts: list[Account]) -> None:
    """What is owed on the property loan behind each balance-less mortgage."""
    from app.models.asset import Loan
    from app.modules.portfolio.valuation import current_loan_balance

    by_asset = {
        a.linked_asset_id: a for a in accounts
        if a.linked_asset_id is not None and a.current_balance is None
    }
    if not by_asset:
        return
    for loan in (await db.scalars(select(Loan).where(Loan.asset_id.in_(by_asset)))).all():
        by_asset[loan.asset_id]._loan_balance = round(current_loan_balance(loan), 2)


def _account_out(acct: Account) -> dict:
    return {
        "id": acct.id,
        "display_name": acct.display_name,
        "account_type": acct.account_type,
        "currency": acct.currency,
        "institution_name": acct.institution.name if acct.institution else None,
        **_balance_out(acct),
        "credit_limit": float(acct.credit_limit) if acct.credit_limit is not None else None,
        "linked_asset_id": acct.linked_asset_id,
        "description_pattern": acct.description_pattern,
        "liability": _liability_out(getattr(acct, "_liability", None)),
        "other_funds_value": _num(acct.other_funds_value),
        "other_funds_as_of": acct.other_funds_as_of.isoformat() if acct.other_funds_as_of else None,
        "other_funds_prev_value": _num(acct.other_funds_prev_value),
        "contributions_total": _num(acct.contributions_total),
        "hsa_coverage": acct.hsa_coverage,
        "exclude_from_net_worth": bool(acct.exclude_from_net_worth),
        **classification.describe(acct),
    }


def _num(v) -> float | None:
    return float(v) if v is not None else None


def _validated_subtype(value: str | None) -> str | None:
    """A known investment subtype in canonical spelling, or 400."""
    if value is None or not value.strip():
        return None
    known = classification.lookup(value)
    if not known:
        raise HTTPException(status_code=400, detail="Unknown account subtype.")
    return known.value


def _classify(investment_type: str | None, subtype: str | None) -> tuple[str, str]:
    """A type and sub-type the add/edit form may pick, or 400. Returns them in
    canonical spelling."""
    if investment_type not in classification.PURPOSES:
        raise HTTPException(status_code=400, detail="Invalid investment type.")
    canonical = _validated_subtype(subtype)
    if not canonical or not classification.allowed_for_type(investment_type, canonical):
        raise HTTPException(status_code=400, detail="Pick a sub-type for this type.")
    return investment_type, canonical


async def _account_out_one(db: AsyncSession, acct: Account) -> dict:
    """Serialize one account with its loan balance attached."""
    await _attach_loan_balances(db, [acct])
    return _account_out(acct)


def _liability_out(row) -> dict | None:
    """Serialize AccountLiability, or None when the account has no detail."""
    if row is None:
        return None

    def money(value):
        return float(value) if value is not None else None

    def day(value):
        return value.isoformat() if value else None

    return {
        "kind": row.kind,
        # `source` is what tells the UI whether these came from the bank or
        # were typed, and therefore whether a sync may replace them.
        "apr_pct": money(row.apr_pct),
        "apr_type": row.apr_type,
        "minimum_payment": money(row.minimum_payment),
        "next_payment_due_date": day(row.next_payment_due_date),
        "next_monthly_payment": money(row.next_monthly_payment),
        "last_payment_amount": money(row.last_payment_amount),
        "last_payment_date": day(row.last_payment_date),
        "last_statement_balance": money(row.last_statement_balance),
        "last_statement_date": day(row.last_statement_date),
        "origination_date": day(row.origination_date),
        "origination_principal": money(row.origination_principal),
        "maturity_date": day(row.maturity_date),
        "expected_payoff_date": day(row.expected_payoff_date),
        "term_months": row.term_months,
        "escrow_balance": money(row.escrow_balance),
        "is_overdue": row.is_overdue,
        "has_pmi": row.has_pmi,
    }


async def _attach_liabilities(db: AsyncSession, accounts: list[Account]) -> None:
    """Load liability detail for a page of accounts in one query."""
    from app.models.account_liability import AccountLiability

    debt_ids = [a.id for a in accounts if a.account_type in DEBT_TYPES]
    if not debt_ids:
        return
    rows = {
        row.account_id: row for row in (await db.scalars(
            select(AccountLiability).where(
                AccountLiability.account_id.in_(debt_ids)
            )
        )).all()
    }
    for account in accounts:
        account._liability = rows.get(account.id)


@router.get("", response_model=list[AccountOut])
async def list_accounts(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.scalars(
        select(Account)
        .where(Account.user_id == user.id)
        .options(selectinload(Account.institution))
        .order_by(Account.display_name)
    )).all()
    await _attach_liabilities(db, list(rows))
    await _attach_loan_balances(db, list(rows))

    return [_account_out(a) for a in rows]


@router.get("/classification")
async def account_classification(user: User = Depends(get_current_user)):
    """The investment types the add/edit form offers, each with its short
    list of sub-types, in display order. Choosing a sub-type decides the
    account's coarse account_type and its tax treatment."""
    def sub(value: str) -> dict:
        s = classification.lookup(value)
        return {
            "value": s.value,
            "label": s.label,
            "tax_treatment": s.tax_treatment,
            "tax_treatment_label": classification.TAX_TREATMENT_LABELS.get(s.tax_treatment),
            "account_type": classification.investment_account_type(s.value),
        }

    return {
        "types": [
            {
                "value": t,
                "label": classification.PURPOSE_LABELS[t],
                "subtypes": [sub(v) for v in classification.MANUAL_SUBTYPES[t]],
            }
            for t in classification.PURPOSES
        ],
    }


@router.get("/balance-history")
async def balance_history(
    days: int = Query(default=90, ge=7, le=3660),
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    account_id: int | None = Query(default=None),
    # Investments → Overview charts accounts at market value, counting what
    # the user excluded from net worth. Accounts keeps the default.
    include_excluded: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Each account's balance over the last ``days``, or between two dates: the
    sparkline on its card, or with ``account_id`` the chart in its drawer.
    Keyed by account id; debts are positive amounts owed."""
    from app.modules.portfolio.account_history import account_balance_series

    end = min(date_to or date.today(), date.today())
    start = date_from or end - timedelta(days=days)
    if start > end or (end - start).days > 3660:
        raise HTTPException(status_code=400, detail="That date range cannot be charted.")
    series = await account_balance_series(
        db, user.id, start, end, account_id, include_excluded=include_excluded,
    )
    return {"series": {str(aid): points for aid, points in series.items()}}


@router.post("", response_model=AccountOut, status_code=status.HTTP_201_CREATED)
async def create_account(
    body: AccountCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.account_type not in ACCOUNT_TYPES:
        raise HTTPException(status_code=400, detail="Invalid account_type.")
    investment_type = subtype = None
    account_type = body.account_type
    if body.investment_type:
        investment_type, subtype = _classify(body.investment_type, body.subtype)
        account_type = classification.investment_account_type(subtype)

    institution_id = None
    if body.institution_name:
        inst = await db.scalar(select(Institution).where(Institution.name == body.institution_name))
        if not inst:
            inst = Institution(name=body.institution_name)
            db.add(inst)
            await db.flush()
        institution_id = inst.id

    acct = Account(
        user_id=user.id,
        display_name=body.display_name,
        account_type=account_type,
        investment_type=investment_type,
        subtype=subtype,
        institution_id=institution_id,
        currency=body.currency,
        current_balance=body.current_balance,
        balance_as_of=date.today() if body.current_balance is not None else None,
        credit_limit=body.credit_limit,
        description_pattern=body.description_pattern,
    )
    db.add(acct)
    await db.flush()
    await record_balance(db, acct.id, body.current_balance)
    await db.commit()
    await db.refresh(acct)
    if institution_id:
        await db.refresh(acct, ["institution"])
    return _account_out(acct)


@router.patch("/{account_id}", response_model=AccountOut)
async def update_account(
    account_id: int,
    body: AccountUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    acct = await db.scalar(
        select(Account)
        .where(Account.id == account_id, Account.user_id == user.id)
        .options(selectinload(Account.institution))
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    updated = body.model_dump(exclude_unset=True)

    if "display_name" in updated and updated["display_name"]:
        acct.display_name = updated["display_name"]
    if "currency" in updated and updated["currency"]:
        acct.currency = updated["currency"]
    if "account_type" in updated and updated["account_type"]:
        if updated["account_type"] not in ACCOUNT_TYPES:
            raise HTTPException(status_code=400, detail="Invalid account_type.")
        acct.account_type = updated["account_type"]
        # Moving to a non-investment type drops the investment classification.
        if acct.account_type not in INVESTMENT_TYPES:
            acct.investment_type = None
            acct.subtype = None
    if "investment_type" in updated or "subtype" in updated:
        investment_type, subtype = _classify(
            updated.get("investment_type", classification.purpose(acct)),
            updated.get("subtype", acct.subtype),
        )
        acct.investment_type = investment_type
        acct.subtype = subtype
        acct.account_type = classification.investment_account_type(subtype)
        acct.classification_set_by_user = True
    if "other_funds_value" in updated:
        new = updated["other_funds_value"]
        if acct.other_funds_value is not None:
            acct.other_funds_prev_value = acct.other_funds_value
        acct.other_funds_value = new
        acct.other_funds_as_of = date.today() if new is not None else None
    if "contributions_total" in updated:
        acct.contributions_total = updated["contributions_total"]
    if "hsa_coverage" in updated:
        if updated["hsa_coverage"] not in (None, "self", "family"):
            raise HTTPException(status_code=400, detail="hsa_coverage must be self or family.")
        acct.hsa_coverage = updated["hsa_coverage"]
    if updated.get("exclude_from_net_worth") is not None:
        acct.exclude_from_net_worth = bool(updated["exclude_from_net_worth"])

    if "institution_name" in updated:
        name = updated["institution_name"]
        if not name:
            acct.institution_id = None
            acct.institution = None
        else:
            inst = await db.scalar(select(Institution).where(Institution.name == name))
            if not inst:
                inst = Institution(name=name)
                db.add(inst)
                await db.flush()
            acct.institution_id = inst.id
            acct.institution = inst

    if "current_balance" in updated:
        acct.current_balance = updated["current_balance"]
        acct.balance_as_of = date.today() if updated["current_balance"] is not None else None
        await record_balance(db, acct.id, updated["current_balance"])
        await sync_linked_loan(db, acct)

    if "credit_limit" in updated:
        acct.credit_limit = updated["credit_limit"]

    if "description_pattern" in updated:
        acct.description_pattern = updated["description_pattern"] or None

    await db.commit()
    await db.refresh(acct, ["institution"])
    return await _account_out_one(db, acct)


class BalanceUpdate(BaseModel):
    balance: Money
    as_of_date: PastDate


@router.post("/{account_id}/balance", status_code=status.HTTP_204_NO_CONTENT)
async def set_account_balance(
    account_id: int,
    body: BalanceUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Manually record the current balance for an account, with the date it was observed."""
    acct = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    acct.current_balance = body.balance
    acct.balance_as_of = body.as_of_date
    await record_balance(db, acct.id, body.balance, body.as_of_date)
    await sync_linked_loan(db, acct)
    await db.commit()


# Ordered SQL to remove an account's entire subtree. Explicit deletes because
# SQLAlchemy's ORM cascade is unreliable for async sessions with unloaded
# collections, and SQLite does not enforce FK constraints by default.
_ACCOUNT_WIPE_SQL = [
    ("trades", "DELETE FROM trade WHERE holding_id IN (SELECT id FROM holding WHERE account_id = :aid)"),
    ("holdings", "DELETE FROM holding WHERE account_id = :aid"),
    ("attachments", 'DELETE FROM transaction_attachment WHERE transaction_id IN (SELECT id FROM "transaction" WHERE account_id = :aid)'),
    ("transactions", 'DELETE FROM "transaction" WHERE account_id = :aid'),
    ("csv_mappings", "DELETE FROM csv_mapping WHERE account_id = :aid"),
    ("balance_history", "DELETE FROM account_balance_snapshot WHERE account_id = :aid"),
]

async def delete_account_and_children(
    db: AsyncSession, account: Account, *, delete_property: bool = False
) -> dict[str, int]:
    """Delete an account and every row that hangs off it. Returns per-table
    delete counts. Caller commits.

    A mortgage account behind a property takes the property's loan with it, so
    the debt stops being counted; the property itself goes only with
    ``delete_property``, and otherwise stays as owned outright.
    """
    from sqlalchemy import inspect as sa_inspect, text

    await release_linked_property(db, account, delete_property=delete_property)

    conn = await db.connection()
    existing = await conn.run_sync(lambda c: set(sa_inspect(c).get_table_names()))

    # Receipt files first: the raw DELETE below removes their rows, and with
    # them the only record of where the files are.
    from app.models.transaction import Transaction
    from app.modules.maintenance.files import delete_attachment_files

    txn_ids = list((await db.scalars(
        select(Transaction.id).where(Transaction.account_id == account.id)
    )).all())
    await delete_attachment_files(db, txn_ids)

    deleted: dict[str, int] = {}
    for label, stmt in _ACCOUNT_WIPE_SQL:
        table = stmt.split("FROM ")[1].split()[0].strip('"').lower()
        if table in existing:
            result = await db.execute(text(stmt), {"aid": account.id})
            deleted[label] = result.rowcount or 0

    await db.delete(account)
    return deleted


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_account(
    account_id: int,
    delete_property: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete an account and its data.

    For a mortgage behind a property, ``delete_property`` says whether the
    property goes too. Either way its loan does, so no debt is left counted
    without an account.
    """
    acct = await db.scalar(
        select(Account).where(Account.id == account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")
    await delete_account_and_children(db, acct, delete_property=delete_property)
    await db.commit()


class LiabilityUpdate(BaseModel):
    """Hand-entered liability detail."""
    kind: str | None = None
    apr_pct: Percent | None = None
    apr_type: str | None = None
    minimum_payment: NonNegativeMoney | None = None
    next_payment_due_date: ReasonableDate | None = None
    next_monthly_payment: NonNegativeMoney | None = None
    last_payment_amount: NonNegativeMoney | None = None
    last_payment_date: PastDate | None = None
    last_statement_balance: Money | None = None
    last_statement_date: PastDate | None = None
    origination_date: ReasonableDate | None = None
    origination_principal: NonNegativeMoney | None = None
    maturity_date: ReasonableDate | None = None
    term_months: TermMonths | None = None
    escrow_balance: Money | None = None
    is_overdue: bool | None = None
    has_pmi: bool | None = None


@router.put("/{account_id}/liability", response_model=AccountOut)
async def upsert_liability(
    account_id: int,
    body: LiabilityUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Set liability detail by hand, for any card, loan or mortgage account."""
    from app.models.account_liability import AccountLiability

    acct = await db.scalar(
        select(Account)
        .where(Account.id == account_id, Account.user_id == user.id)
        .options(selectinload(Account.institution))
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")
    if acct.account_type not in DEBT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Liability detail applies to credit, loan and mortgage accounts",
        )

    row = await db.get(AccountLiability, account_id)
    if row is None:
        row = AccountLiability(account_id=account_id)
        db.add(row)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(row, field, value)

    await db.commit()
    await db.refresh(row)
    acct._liability = row
    return await _account_out_one(db, acct)

"""Mortgage endpoint — atomically creates an Account + Asset + Loan in one transaction.

With ``account_id`` it uses a mortgage account the user already has instead
of creating a second account for the same debt. The debt is then counted once, through the property's loan,
whose balance follows that account (see ``sync_linked_loan``).
"""
import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from typing import Optional

from app.api.assets import LoanIn, _amortize, _asset_out
from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.validation import (
    DescriptionPattern, NonNegativeMoney, PastDate, Percent, PositiveMoney, ReasonableDate,
    TermMonths,
)
from app.models.account import Account, Institution
from app.models.asset import Asset, Loan, PaymentSchedule
from app.models.user import User
from app.modules.portfolio.valuation import LOAN_TYPES

router = APIRouter(prefix="/api/mortgage", tags=["mortgage"])


class MortgageCreate(BaseModel):
    # An existing loan/mortgage account to put behind the property. When set,
    # the account fields below are ignored and no account is created.
    account_id: Optional[int] = None

    # Account fields
    display_name: str = ""
    institution_name: Optional[str] = None
    description_pattern: DescriptionPattern = None

    # Asset / property fields. The same rules as Add Property on its own
    # (assets.AssetCreate and LoanIn): this route used to take any number, so
    # a home could be saved at -$650,000 with a 150% share.
    property_address: str = Field(min_length=1, max_length=255)
    category: str = "primary_home"
    current_value: Optional[PositiveMoney] = None
    acquired_value: Optional[PositiveMoney] = None
    acquired_at: Optional[PastDate] = None
    ownership_pct: float = Field(100.0, gt=0, le=100)
    zillow_url: Optional[str] = None

    # Loan fields
    principal: PositiveMoney
    rate_apr: Percent
    term_months: TermMonths
    origination: ReasonableDate
    extra_principal_monthly: NonNegativeMoney = 0
    insurance_monthly: NonNegativeMoney = 0
    property_tax_monthly: NonNegativeMoney = 0


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_mortgage(
    body: MortgageCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.category not in ("primary_home", "rental"):
        raise HTTPException(status_code=400, detail="category must be primary_home or rental")

    existing: Account | None = None
    if body.account_id is not None:
        existing = await db.scalar(
            select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
        )
        if existing is None or existing.account_type not in LOAN_TYPES:
            raise HTTPException(status_code=404, detail="No mortgage or loan account with that id")
        if existing.linked_asset_id is not None:
            raise HTTPException(
                status_code=409,
                detail=f"{existing.display_name} already belongs to another property.",
            )

    # Resolve or create institution
    institution_id = None
    if body.institution_name and existing is None:
        inst = await db.scalar(select(Institution).where(Institution.name == body.institution_name))
        if not inst:
            inst = Institution(name=body.institution_name)
            db.add(inst)
            await db.flush()
        institution_id = inst.id

    # 1. Create Asset
    metadata = {"zillow_url": body.zillow_url or ""}
    asset = Asset(
        user_id=user.id,
        category=body.category,
        name=body.property_address,
        ownership_pct=body.ownership_pct,
        current_value=body.current_value,
        acquired_value=body.acquired_value,
        acquired_at=body.acquired_at,
        metadata_json=json.dumps(metadata),
    )
    db.add(asset)
    await db.flush()

    # 2. Build amortization schedule and create Loan
    loan_in = LoanIn(
        principal=body.principal,
        rate_apr=body.rate_apr,
        term_months=body.term_months,
        origination=body.origination,
        extra_principal_monthly=body.extra_principal_monthly,
        insurance_monthly=body.insurance_monthly,
        property_tax_monthly=body.property_tax_monthly,
    )
    # An existing account already knows what is owed today, which
    # beats a schedule derived from the original terms: anchor on it.
    override = (
        abs(float(existing.current_balance))
        if existing is not None and existing.current_balance is not None else None
    )
    override_date = date.today() if override is not None else None
    loan = Loan(
        asset_id=asset.id,
        principal=body.principal,
        rate_apr=body.rate_apr,
        term_months=body.term_months,
        origination=body.origination,
        extra_principal_monthly=body.extra_principal_monthly,
        insurance_monthly=body.insurance_monthly,
        property_tax_monthly=body.property_tax_monthly,
        balance_override=override,
        balance_override_date=override_date,
    )
    db.add(loan)
    await db.flush()

    schedule_data = _amortize(loan_in, balance_override=override, balance_override_date=override_date)
    for row in schedule_data:
        db.add(PaymentSchedule(
            loan_id=loan.id,
            month_number=row["month_number"],
            payment_date=row["payment_date"],
            principal=row["principal"],
            interest=row["interest"],
            escrow=row["escrow"],
            balance=row["balance"],
        ))

    # 3. Link the existing account, or create one, to the Asset
    if existing is not None:
        acct = existing
        acct.linked_asset_id = asset.id
    else:
        acct = Account(
            user_id=user.id,
            # Named for the lender and the home, like a synced mortgage is
            # named for its lender, rather than the address alone.
            display_name=body.display_name.strip() or (
                f"{body.institution_name.strip()} · {body.property_address}"
                if body.institution_name and body.institution_name.strip()
                else body.property_address
            )[:100],
            account_type="mortgage",
            institution_id=institution_id,
            currency="USD",
            linked_asset_id=asset.id,
            description_pattern=body.description_pattern or None,
        )
        db.add(acct)
    await db.commit()

    await db.refresh(asset)
    await db.refresh(loan)
    await db.refresh(acct)
    if acct.institution_id:
        await db.refresh(acct, ["institution"])

    schedule_rows = (await db.scalars(
        select(PaymentSchedule)
        .where(PaymentSchedule.loan_id == loan.id)
        .order_by(PaymentSchedule.month_number)
    )).all()

    return {
        "account": {
            "id": acct.id,
            "display_name": acct.display_name,
            "account_type": acct.account_type,
            "currency": acct.currency,
            "institution_name": acct.institution.name if acct.institution else None,
            "current_balance": float(acct.current_balance) if acct.current_balance is not None else None,
            "credit_limit": None,
            "linked_asset_id": acct.linked_asset_id,
            "description_pattern": acct.description_pattern,
        },
        "asset": _asset_out(asset, list(schedule_rows)),
    }

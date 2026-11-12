"""Per-account and per-asset breakdown for the portfolio page."""
import json

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.account import Account
from app.models.asset import Asset
from app.models.transaction import Transaction

from app.modules.portfolio.valuation import (
    CASH_TYPES,
    CREDIT_CARD_TYPES,
    INVESTMENT_TYPES,
    LOAN_TYPES,
    is_asset_backed_loan_account,
    owned_loan_balance,
    ownership_share,
)

PROPERTY_CATEGORIES = {"primary_home", "rental"}


TYPE_LABELS: dict[str, str] = {
    "checking": "Checking", "savings": "Savings",
    "credit_card": "Credit Card",
    "brokerage": "Brokerage", "401k": "401(k)", "ira": "IRA",
    "roth_ira": "Roth IRA", "hsa": "HSA", "529": "529 Plan",
    "loan": "Loan", "mortgage": "Mortgage",
    "primary_home": "Primary Home", "rental": "Rental",
    "vehicle": "Vehicle", "precious_metal": "Precious Metal",
    "collectible": "Collectible", "other": "Other",
}


async def get_portfolio_breakdown(user_id: int, db: AsyncSession) -> dict:
    # ── Accounts ──────────────────────────────────────────────────────────────
    accounts = (await db.scalars(
        select(Account)
        .where(Account.user_id == user_id)
        .options(selectinload(Account.institution))
        .order_by(Account.display_name)
    )).all()

    account_ids = [a.id for a in accounts]

    # Build a map of account_id → current_balance (stored on the Account row itself).
    # This is set from OFX LEDGERBAL or the last CSV transaction's running balance.
    stored_balance: dict[int, float] = {
        a.id: float(a.current_balance)
        for a in accounts
        if a.current_balance is not None
    }

    # Fallback: latest per-transaction running balance (from CSV imports that store it).
    from sqlalchemy import desc

    rn_col = func.row_number().over(
        partition_by=Transaction.account_id,
        order_by=[desc(Transaction.date_posted), desc(Transaction.id)],
    ).label("rn")

    ranked_sq = (
        select(Transaction.account_id, Transaction.balance, rn_col)
        .where(Transaction.account_id.in_(account_ids))
        .subquery()
    ) if account_ids else None

    txn_balance: dict[int, float] = {}
    if ranked_sq is not None:
        balance_rows = (await db.execute(
            select(ranked_sq.c.account_id, ranked_sq.c.balance)
            .where(ranked_sq.c.rn == 1)
        )).all()
        txn_balance = {
            r.account_id: float(r.balance)
            for r in balance_rows
            if r.balance is not None
        }

    def acct_balance(acct_id: int) -> float:
        # Priority: stored account balance > latest transaction balance > 0
        if acct_id in stored_balance:
            return stored_balance[acct_id]
        if acct_id in txn_balance:
            bal = txn_balance[acct_id]
            if bal != 0.0:
                return bal
        return 0.0

    # ── Investment values: the same book the summary card reads ───────
    from app.modules.portfolio.positions import build_investment_book

    book = await build_investment_book(db, user_id)

    # ── Assets (properties + other) ───────────────────────────────────────────
    assets = (await db.scalars(
        select(Asset)
        .where(Asset.user_id == user_id)
        .options(selectinload(Asset.loan))
        .order_by(Asset.name)
    )).all()

    # ── Build response ─────────────────────────────────────────────────────────
    cash, investments, credit_cards, loan_accounts = [], [], [], []

    for a in accounts:
        inst = a.institution.name if a.institution else None
        label = TYPE_LABELS.get(a.account_type, a.account_type)
        base = {"id": a.id, "name": a.display_name, "type": a.account_type,
                "type_label": label, "institution": inst, "currency": a.currency}

        if a.account_type in CASH_TYPES:
            cash.append({**base, "balance": acct_balance(a.id)})

        elif a.account_type in INVESTMENT_TYPES:
            # Positions and an "Other funds" value add up; only an account
            # nothing tracks falls back to its balance.
            av = book.account_value(a, fallback_balance=acct_balance(a.id))

            investments.append({
                **base,
                "value": av.value,
                # Listed but left out of the section total and net worth.
                "excluded": bool(a.exclude_from_net_worth),
                # Where the value came from: "positions" | "balance".
                "value_source": av.value_source,
            })

        elif a.account_type in CREDIT_CARD_TYPES:
            credit_cards.append({**base, "balance": acct_balance(a.id)})

        elif a.account_type in LOAN_TYPES:
            # Mortgage accounts created by POST /api/mortgage carry a linked
            # Asset whose Loan already supplies the balance in `mortgages`
            # below; listing them here too would double the debt.
            if is_asset_backed_loan_account(a):
                continue
            loan_accounts.append({**base, "balance": acct_balance(a.id)})

    mortgages, other_assets_list = [], []

    for a in assets:
        val = float(a.current_value or 0) * ownership_share(a)
        meta: dict = {}
        try:
            meta = json.loads(a.metadata_json) if a.metadata_json else {}
        except Exception:
            pass

        excluded = bool(meta.get("exclude_from_net_worth", False))
        if a.category in PROPERTY_CATEGORIES:
            loan_bal = owned_loan_balance(a)
            mortgages.append({
                "id": a.id,
                "name": a.name,
                "type": a.category,
                "type_label": TYPE_LABELS.get(a.category, a.category),
                "property_value": val,
                "loan_balance": loan_bal,
                "equity": val - loan_bal,
                "exclude_from_net_worth": excluded,
            })
        else:
            loan_bal = owned_loan_balance(a)
            other_assets_list.append({
                "id": a.id,
                "name": a.name,
                "type": a.category,
                "type_label": TYPE_LABELS.get(a.category, a.category),
                "value": val,
                "loan_balance": loan_bal,
                "equity": val - loan_bal,
                "exclude_from_net_worth": excluded,
            })

    return {
        "cash": cash,
        "investments": investments,
        "credit_cards": credit_cards,
        "loans": loan_accounts,
        "mortgages": mortgages,
        "other_assets": other_assets_list,
    }

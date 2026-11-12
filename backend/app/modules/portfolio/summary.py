"""Net worth and portfolio summary aggregation."""
import json

from fastapi import BackgroundTasks
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.account import Account
from app.models.asset import Asset
from app.modules.investments.market_data import refresh_symbols

from app.modules.portfolio.fees import summarize_fees
from app.modules.portfolio.valuation import (
    CASH_TYPES,
    LOAN_TYPES,
    loan_account_debt,
    owned_loan_balance,
    ownership_share,
)


async def get_portfolio_summary(
    user_id: int,
    db: AsyncSession,
    background_tasks: BackgroundTasks | None = None,
) -> dict:
    # ── Investments ───────────────────────────────────────────────────────────
    # One book, shared with GET /api/holdings, so the Holdings table and this
    # card cannot disagree. See modules/portfolio/positions.
    from app.modules.portfolio.positions import build_investment_book, investment_totals

    book = await build_investment_book(db, user_id)
    totals = investment_totals(book)
    investment_value = totals.investment_value
    total_cost_basis = totals.total_cost_basis
    costed_value = totals.costed_value
    by_account_type = totals.by_account_type
    fee_positions = totals.fee_positions
    stale_tickers = book.stale_tickers
    fee_analysis = summarize_fees(fee_positions)

    # ── Real assets ───────────────────────────────────────────────────────────
    assets = (await db.scalars(
        select(Asset)
        .where(Asset.user_id == user_id)
        .options(selectinload(Asset.loan))
    )).all()

    property_value = 0.0
    other_asset_value = 0.0
    total_loan_balance = 0.0

    for a in assets:
        meta = json.loads(a.metadata_json) if a.metadata_json else {}
        if meta.get("exclude_from_net_worth"):
            continue
        val = float(a.current_value or 0) * ownership_share(a)
        if a.category in ("primary_home", "rental"):
            property_value += val
        else:
            other_asset_value += val

        total_loan_balance += owned_loan_balance(a)

    # ── Cash / savings balances ───────────────────────────────────────────────
    cash_accounts = (await db.scalars(
        select(Account).where(
            Account.user_id == user_id,
            Account.account_type.in_(CASH_TYPES),
            Account.current_balance.isnot(None),
        )
    )).all()
    total_cash = sum(float(a.current_balance or 0) for a in cash_accounts)

    # ── Credit card balances ──────────────────────────────────────────────────
    cc_accounts = (await db.scalars(
        select(Account).where(
            Account.user_id == user_id,
            Account.account_type == "credit_card",
        )
    )).all()

    total_cc_balance = sum(float(a.current_balance or 0) for a in cc_accounts)

    # ── Loan / mortgage account balances ──────────────────────────────────────
    # Standalone loan and mortgage accounts carry their own balance. Accounts created by
    # POST /api/mortgage instead point at an Asset whose Loan is already in
    # total_loan_balance above, and loan_account_debt() returns 0 for those so
    # the debt is not counted twice. Before this, `loan` accounts were dropped
    # from liabilities entirely and `mortgage` accounts were in no debt set at
    # all, so both read as free money.
    debt_accounts = (await db.scalars(
        select(Account).where(
            Account.user_id == user_id,
            Account.account_type.in_(LOAN_TYPES),
        )
    )).all()
    total_loan_account_balance = sum(loan_account_debt(a) for a in debt_accounts)

    # ── Net worth ─────────────────────────────────────────────────────────────
    total_assets = investment_value + property_value + other_asset_value + total_cash
    total_liabilities = (
        total_loan_balance + total_cc_balance + total_loan_account_balance
    )
    net_worth = total_assets - total_liabilities

    # Asset breakdown for the donut. Its slices must add up to total_assets —
    # the chart prints that total in its centre — so cash and
    # any investment value on an unlisted account type get slices too.
    asset_breakdown = []
    if total_cash > 0:
        asset_breakdown.append({"label": "cash", "value": total_cash})
    listed = ("brokerage", "401k", "ira", "roth_ira", "hsa", "529")
    for acct_type in listed:
        v = by_account_type.get(acct_type, 0)
        if v > 0:
            asset_breakdown.append({"label": acct_type, "value": v})
    other_investments = sum(
        v for k, v in by_account_type.items() if k not in listed and v > 0
    )
    if other_investments > 0:
        asset_breakdown.append({"label": "other_investments", "value": other_investments})
    if property_value > 0:
        asset_breakdown.append({"label": "property", "value": property_value})
    if other_asset_value > 0:
        asset_breakdown.append({"label": "other_assets", "value": other_asset_value})

    # Warm the quote cache out-of-band for any ticker we served stale, so the
    # next request resolves from cache without a network round-trip.
    if background_tasks is not None and stale_tickers:
        background_tasks.add_task(refresh_symbols, list(stale_tickers))

    return {
        "net_worth": net_worth,
        "total_assets": total_assets,
        "total_liabilities": total_liabilities,
        "investment_value": investment_value,
        "total_cost_basis": total_cost_basis,
        "costed_value": costed_value,
        "total_gain": costed_value - total_cost_basis,
        "property_value": property_value,
        "other_asset_value": other_asset_value,
        "total_loan_balance": total_loan_balance,
        "total_loan_account_balance": total_loan_account_balance,
        "total_cc_balance": total_cc_balance,
        # Kept for older clients; both now come from fee_analysis.
        "weighted_expense_ratio": fee_analysis["weighted_expense_ratio"],
        "annual_fee_drag": fee_analysis["annual_fee"],
        "fee_analysis": fee_analysis,
        "total_cash": total_cash,
        "asset_breakdown": asset_breakdown,
    }

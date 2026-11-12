"""Investment activity: every buy, sale, dividend and fee across a user's holdings.

A brokerage's activity, entered by hand or imported from an OFX file, becomes
``Trade`` rows on each holding. The cash ``Transaction`` table never sees
them, so this is the one list of that activity, across holdings.

  GET /api/investments/activity
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_db, get_user_account_ids
from app.models.account import Account
from app.models.holding import Holding
from app.models.security import Security
from app.models.trade import INCOME_ACTIONS, Trade
from app.models.user import User

router = APIRouter(prefix="/api/investments", tags=["investment-activity"])

#: The filter the page offers, and the actions each one covers.
ACTIVITY_KINDS: dict[str, tuple[str, ...]] = {
    "trades": ("buy", "sell", "reinvest"),
    "income": INCOME_ACTIONS,
    "transfers": ("transfer_in", "transfer_out"),
    "other": ("fee", "split"),
}

#: Actions whose shares and price mean something. A dividend has neither, and
#: some brokers send a placeholder price of 1.00 with one.
_SHARE_ACTIONS = frozenset({"buy", "sell", "reinvest", "transfer_in", "transfer_out"})


def _total(trade: Trade) -> float | None:
    """The money that moved: the recorded amount, or shares at the price."""
    if trade.amount is not None:
        return float(trade.amount)
    if trade.action in _SHARE_ACTIONS and trade.price_per_share is not None:
        return round(float(trade.shares or 0) * float(trade.price_per_share), 2)
    return None


@router.get("/activity")
async def investment_activity(
    date_from: Optional[date] = Query(None),
    date_to: Optional[date] = Query(None),
    account_id: Optional[int] = Query(None),
    kind: Optional[str] = Query(None, description="trades | income | transfers | other"),
    search: Optional[str] = Query(None, max_length=100),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    empty = {"items": [], "total": 0, "page": page, "page_size": page_size,
             "income_total": 0.0}
    if not user_acct_ids or (account_id is not None and account_id not in user_acct_ids):
        return empty

    filters = [Holding.account_id.in_(user_acct_ids)]
    if account_id is not None:
        filters.append(Holding.account_id == account_id)
    if date_from:
        filters.append(Trade.trade_date >= date_from)
    if date_to:
        filters.append(Trade.trade_date <= date_to)
    if kind in ACTIVITY_KINDS:
        filters.append(Trade.action.in_(ACTIVITY_KINDS[kind]))
    if search and search.strip():
        like = f"%{search.strip().lower()}%"
        filters.append(or_(
            func.lower(Security.ticker).like(like),
            func.lower(Security.name).like(like),
        ))

    base = (
        select(Trade)
        .join(Holding, Holding.id == Trade.holding_id)
        .join(Security, Security.id == Holding.security_id)
        .where(*filters)
    )
    total, income_total = (await db.execute(
        select(
            func.count(Trade.id),
            func.coalesce(func.sum(case(
                (Trade.action.in_(INCOME_ACTIONS), Trade.amount), else_=0)), 0),
        )
        .select_from(Trade)
        .join(Holding, Holding.id == Trade.holding_id)
        .join(Security, Security.id == Holding.security_id)
        .where(*filters)
    )).one()

    rows = (await db.execute(
        base.add_columns(
            Holding.account_id, Security.ticker, Security.name, Account.display_name,
        )
        .join(Account, Account.id == Holding.account_id)
        .order_by(Trade.trade_date.desc(), Trade.id.desc())
        .limit(page_size).offset((page - 1) * page_size)
    )).all()

    items = []
    for trade, acct_id, ticker, name, account_name in rows:
        moves_shares = trade.action in _SHARE_ACTIONS
        items.append({
            "id": trade.id,
            "holding_id": trade.holding_id,
            "account_id": acct_id,
            "account_name": account_name,
            "ticker": ticker,
            "security_name": name,
            "trade_date": trade.trade_date.isoformat(),
            "action": trade.action,
            "shares": float(trade.shares or 0) if moves_shares else None,
            "price_per_share": (
                float(trade.price_per_share)
                if moves_shares and trade.price_per_share is not None else None
            ),
            "split_ratio": float(trade.split_ratio) if trade.split_ratio is not None else None,
            "total": _total(trade),
            "is_income": trade.action in INCOME_ACTIONS,
        })

    return {
        "items": items, "total": total or 0, "page": page, "page_size": page_size,
        "income_total": round(float(income_total or 0), 2),
    }

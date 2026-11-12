"""Investment income: dividend suggestions + portfolio income summary.

Endpoints:
  GET  /api/holdings/{id}/dividend-suggestions          — detected-but-unrecorded dividends
  POST /api/holdings/{id}/dividend-suggestions/confirm  — record selected suggestions as trades
  GET  /api/portfolio/income?year=                      — income received + projection
"""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.core.validation import Money, NonNegativeMoney, PastDate, Quantity
from app.models.holding import Holding
from app.models.security import Security, SecurityDividend, SecurityInfo
from app.models.trade import INCOME_ACTIONS, Trade
from app.models.user import User
from app.modules.investments.activity import ensure_opening_trade, recalc_holding, shares_on_date
from app.modules.investments.dividends import is_recently_synced, upsert_dividends
from app.modules.investments.market_data import get_dividend_history

router = APIRouter(tags=["investment-income"])

# Suggestions within this window of an existing dividend/reinvest trade are
# considered already recorded (pay dates trail ex-dates by a few days).
RECORDED_WINDOW_DAYS = 5


async def _owned_holding(holding_id: int, user_acct_ids: list[int], db: AsyncSession) -> Holding:
    holding = await db.scalar(
        select(Holding).where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")
    return holding


# ── Dividend suggestions ──────────────────────────────────────────────────────

@router.get("/api/holdings/{holding_id}/dividend-suggestions")
async def dividend_suggestions(
    holding_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await _owned_holding(holding_id, user_acct_ids, db)

    trades = list((await db.scalars(
        select(Trade).where(Trade.holding_id == holding_id).order_by(Trade.trade_date, Trade.id)
    )).all())
    if not any(t.action == "buy" for t in trades):
        # Without trade history we can't know shares held on an ex-date.
        return {"suggestions": [], "reason": "no_trade_history"}

    dividends = (await db.scalars(
        select(SecurityDividend)
        .where(SecurityDividend.security_id == holding.security_id)
        .order_by(SecurityDividend.ex_date.desc())
    )).all()

    recorded_dates = [t.trade_date for t in trades if t.action in ("dividend", "reinvest")]
    window = timedelta(days=RECORDED_WINDOW_DAYS)

    suggestions = []
    for d in dividends:
        held = shares_on_date(trades, d.ex_date)
        if held <= 0:
            continue
        already = any(abs(rd - d.ex_date) <= window for rd in recorded_dates)
        suggestions.append({
            "ex_date": d.ex_date.isoformat(),
            "amount_per_share": float(d.amount_per_share),
            "shares_held": held,
            "total": round(held * float(d.amount_per_share), 2),
            "already_recorded": already,
            # Unadjusted close on the ex-date — used to estimate DRIP share
            # count. None for older syncs that predate this column; frontend
            # falls back to the current live price in that case.
            "price_hint": float(d.price_hint) if d.price_hint is not None else None,
        })
    return {"suggestions": suggestions}


@router.post("/api/holdings/{holding_id}/refresh-dividends")
async def refresh_holding_dividends(
    holding_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    """Pull this holding's security dividend history from yfinance on demand,
    so a just-added ticker doesn't have to wait for the weekly job.

    Rate-limited per security (not per user): dividend data is identical for
    every holder, so once it's been synced within the cooldown we skip the
    network call and report it as already up to date — the suggestions endpoint
    already reads the freshly-stored rows.
    """
    holding = await _owned_holding(holding_id, user_acct_ids, db)
    security = await db.get(Security, holding.security_id)
    if not security or not security.ticker:
        raise HTTPException(status_code=400, detail="This holding has no ticker to look up dividends for.")

    if is_recently_synced(security):
        return {
            "refreshed": False,
            "reason": "recently_synced",
            "synced_at": security.dividends_synced_at.isoformat(),
            "rows": 0,
        }

    # yfinance history is a blocking network call — keep it off the event loop.
    rows = await run_in_threadpool(get_dividend_history, security.ticker)
    written = await upsert_dividends(db, security, rows)
    await db.commit()
    return {
        "refreshed": True,
        "synced_at": security.dividends_synced_at.isoformat(),
        "rows": written,
    }


class SuggestionConfirm(BaseModel):
    ex_date: PastDate
    action: str = "dividend"  # "dividend" | "reinvest"
    amount: Money
    shares: Optional[Quantity] = None            # reinvest only
    price_per_share: Optional[NonNegativeMoney] = None   # reinvest only
    is_qualified: Optional[bool] = None


class SuggestionConfirmBody(BaseModel):
    confirmations: list[SuggestionConfirm]


@router.post("/api/holdings/{holding_id}/dividend-suggestions/confirm", status_code=201)
async def confirm_dividend_suggestions(
    holding_id: int,
    body: SuggestionConfirmBody,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await _owned_holding(holding_id, user_acct_ids, db)
    if body.confirmations:
        # Keep shares from a statement or the edit form once trades take over.
        await ensure_opening_trade(holding, min(c.ex_date for c in body.confirmations), db)

    created = []
    for c in body.confirmations:
        if c.action not in ("dividend", "reinvest"):
            raise HTTPException(status_code=400, detail="action must be dividend or reinvest")
        if c.amount <= 0:
            raise HTTPException(status_code=400, detail="amount must be positive")
        if c.action == "reinvest" and (not c.shares or c.shares <= 0):
            raise HTTPException(status_code=400, detail="reinvest requires shares purchased")
        trade = Trade(
            holding_id=holding_id,
            trade_date=c.ex_date,
            action=c.action,
            shares=c.shares if c.action == "reinvest" else 0,
            price_per_share=c.price_per_share if c.action == "reinvest" else None,
            amount=c.amount,
            is_qualified=c.is_qualified if c.is_qualified is not None else True,
            notes="Confirmed from detected dividend",
        )
        db.add(trade)
        created.append(trade)

    await db.flush()
    await recalc_holding(holding_id, db)
    await db.commit()
    return {"created": len(created)}


# ── Portfolio income summary ──────────────────────────────────────────────────

@router.get("/api/portfolio/income")
async def portfolio_income(
    year: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    year = year or date.today().year

    income_rows = (await db.execute(
        select(
            Trade.holding_id,
            extract("month", Trade.trade_date).label("month"),
            func.sum(Trade.amount).label("total"),
        )
        .join(Holding, Holding.id == Trade.holding_id)
        .where(
            Holding.account_id.in_(user_acct_ids),
            Trade.action.in_(INCOME_ACTIONS),
            Trade.amount.isnot(None),
            extract("year", Trade.trade_date) == year,
        )
        .group_by(Trade.holding_id, extract("month", Trade.trade_date))
    )).all()

    by_month = [0.0] * 12
    by_holding: dict[int, float] = {}
    for holding_id, month, total in income_rows:
        amt = float(total or 0)
        by_month[int(month) - 1] += amt
        by_holding[holding_id] = by_holding.get(holding_id, 0.0) + amt
    year_total = round(sum(by_month), 2)

    # Projected annual income = Σ dividend_yield × current position value.
    # Position value derives from the latest stored close via shares × close —
    # avoids blocking this request on live quotes.
    from app.models.security import PriceHistory, Security

    latest_close = (
        select(
            PriceHistory.security_id,
            func.max(PriceHistory.as_of).label("max_date"),
        )
        .group_by(PriceHistory.security_id)
        .subquery()
    )
    proj_rows = (await db.execute(
        select(Holding.id, Holding.shares, PriceHistory.close, SecurityInfo.dividend_yield)
        .join(Security, Security.id == Holding.security_id)
        .join(SecurityInfo, SecurityInfo.security_id == Security.id)
        .join(latest_close, latest_close.c.security_id == Security.id)
        .join(
            PriceHistory,
            (PriceHistory.security_id == latest_close.c.security_id)
            & (PriceHistory.as_of == latest_close.c.max_date),
        )
        .where(
            Holding.account_id.in_(user_acct_ids),
            SecurityInfo.dividend_yield.isnot(None),
        )
    )).all()

    projected = 0.0
    for _hid, shares, close, dy in proj_rows:
        if shares and close and dy:
            # yfinance dividendYield is a percentage (e.g. 1.35 = 1.35%)
            projected += float(shares) * float(close) * float(dy) / 100.0

    # Names for the by-holding breakdown
    holding_names: dict[int, str] = {}
    if by_holding:
        name_rows = (await db.execute(
            select(Holding.id, Security.ticker, Security.name)
            .join(Security, Security.id == Holding.security_id)
            .where(Holding.id.in_(by_holding.keys()))
        )).all()
        holding_names = {hid: (ticker or name) for hid, ticker, name in name_rows}

    today = date.today()
    ytd_total = year_total if year == today.year else None

    return {
        "year": year,
        "year_total": year_total,
        "ytd_total": ytd_total,
        "by_month": [round(m, 2) for m in by_month],
        "by_holding": [
            {"holding_id": hid, "label": holding_names.get(hid, str(hid)), "total": round(amt, 2)}
            for hid, amt in sorted(by_holding.items(), key=lambda kv: -kv[1])
        ],
        "projected_annual": round(projected, 2),
    }

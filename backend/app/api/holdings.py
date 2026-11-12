"""Holdings (stocks/ETFs/funds) CRUD + enriched grid payload + trade history."""
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.core.validation import ExpenseRatioPct, Money, NonNegativeMoney, PastDate, Quantity
from app.models.account import Account
from app.models.holding import LOT_METHODS, Holding
from app.models.security import SECURITY_TYPES, Security, PriceHistory, SecurityInfo
from app.models.trade import INCOME_ACTIONS, TRADE_ACTIONS, Trade
from app.models.user import User
from app.modules.investments.activity import ensure_opening_trade, recalc_holding
from app.modules.investments.backfill import backfill_new_security
from app.modules.investments.market_data import get_quote, refresh_symbols
from app.modules.investments.refresh import market_today, trades_weekends
from app.modules.investments.performance import simple_return

router = APIRouter(prefix="/api/holdings", tags=["holdings"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class SecurityIn(BaseModel):
    ticker: Optional[str] = None
    name: str
    type: str = "stock"
    # A percent (0.03 = 0.03%); see Security.expense_ratio.
    expense_ratio: Optional[ExpenseRatioPct] = None


class HoldingCreate(BaseModel):
    account_id: int
    security: SecurityIn
    shares: Optional[Quantity] = None
    cost_basis_total: Optional[NonNegativeMoney] = None
    acquired_at: Optional[PastDate] = None
    lot_method: str = "fifo"


class HoldingUpdate(BaseModel):
    shares: Optional[Quantity] = None
    cost_basis_total: Optional[NonNegativeMoney] = None
    acquired_at: Optional[PastDate] = None
    lot_method: Optional[str] = None
    exclude_from_net_worth: Optional[bool] = None
    is_favorited: Optional[bool] = None
    #: A percent (0.03 = 0.03%). Fills the fund's expense ratio only while it
    #: has none: a security row is shared by everyone who holds that ticker,
    #: so a user can supply a missing figure but not overwrite a known one.
    expense_ratio: Optional[ExpenseRatioPct] = None


class TradeCreate(BaseModel):
    trade_date: PastDate
    action: str  # one of TRADE_ACTIONS
    shares: Quantity = 0.0
    price_per_share: Optional[NonNegativeMoney] = None
    amount: Optional[Money] = None        # cash received (income actions)
    split_ratio: Optional[float] = Field(None, gt=0, le=10_000)   # split actions (2.0 = 2-for-1)
    is_qualified: Optional[bool] = None   # qualified dividend (income actions)
    notes: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

# Prices within this fraction of a stored close are treated as *being* that
# close rather than a live tick that happens to be nearby. Guards against float
# noise between yfinance's quote and the value we persisted.
_SAME_PRICE_EPS = 1e-6


def _session_delta(
    effective_price: float,
    closes: list[tuple[date, float]],
) -> tuple[float | None, float, date | None]:
    """Day change for `effective_price` against the right trading session.

    The baseline has to be the close of the session *before* the one the
    displayed price belongs to. Anchoring it to "yesterday" by calendar date
    breaks whenever the market isn't currently trading: on a Saturday the last
    stored close and the "most recent close before today" are the same Friday
    row, so the delta collapses to exactly $0.00. Same story pre-open, which is
    why the numbers used to blink into life mid-morning once a live quote
    arrived. [issues 5 + 9: zeros on weekends / early in the day]

    `closes` is the security's daily closes, most recent first. Returns
    (day_change, day_change_pct, session_date); day_change is None when there
    isn't enough history to say, and the caller should fall back to the quote.
    """
    if effective_price <= 0 or not closes:
        return None, 0.0, None

    # The market's date, not the server's: in UTC "today" starts at 7-8pm
    # Eastern, while the session that closed at 4pm is still today.
    today = market_today()
    last_date, last_close = closes[0]
    # Is the price we're showing a live tick, or just the last close read back?
    is_live = abs(effective_price - last_close) > last_close * _SAME_PRICE_EPS

    if is_live and last_date < today:
        # Trading now, before today's close has been persisted: compare against
        # the last completed session.
        baseline, session = last_close, today
    elif len(closes) > 1:
        # Market closed (weekend, holiday, pre-open) or today's close already
        # stored — the price *is* `last_close`, so step back one more session.
        baseline, session = closes[1][1], last_date
    else:
        return None, 0.0, None

    if baseline <= 0:
        return None, 0.0, None
    change = effective_price - baseline
    return change, change / baseline * 100, session


def _enrich(
    h: Holding, quote: dict, has_trades: bool = False,
    closes: list[tuple[date, float]] | None = None,
    week52: tuple[float | None, float | None] | None = None,
) -> dict:
    shares = float(h.shares or 0)
    # NULL means "nobody recorded what this cost", which is not the same as a
    # cost of zero. Collapsing the two reported the whole market value as gain:
    # a position with 100 shares and no recorded basis showed $4,000 of
    # "Total G/L". The percentage already guarded against this — it was blank —
    # so the dollar figure was the only one still claiming to know.
    cost = float(h.cost_basis_total) if h.cost_basis_total is not None else None
    price = quote["price"]
    current_value = shares * price
    total_gain = current_value - cost if cost is not None else None
    total_gain_pct = (
        simple_return(cost, current_value) * 100 if cost else None
    )
    # Use the regular-session close for day change so after-hours prices don't
    # make the change appear as ~$0. regular_price is the official session close
    # from yfinance; fall back to the display price if not provided.
    effective_price = quote.get("regular_price") or price
    day_change, day_change_pct, session_date = _session_delta(effective_price, closes or [])
    if day_change is None:
        day_change = quote["day_change"]
        day_change_pct = quote.get("day_change_pct", 0.0)
    day_gain = shares * day_change

    return {
        "id": h.id,
        "account_id": h.account_id,
        "account_name": h.account.display_name if h.account else None,
        "security_id": h.security_id,
        "ticker": h.security.ticker,
        "name": h.security.name,
        "type": h.security.type,
        "expense_ratio": float(h.security.expense_ratio) if h.security.expense_ratio is not None else None,
        "shares": shares,
        "cost_basis_total": cost,   # None when unrecorded — render as "—"
        "acquired_at": h.acquired_at.isoformat() if h.acquired_at else None,
        "lot_method": h.lot_method,
        # live data
        "price": price,
        "current_value": current_value,
        "day_change": day_change,
        "day_change_pct": day_change_pct,
        "day_gain": day_gain,
        # Which session the change above covers. When the market is closed this
        # is the last completed session, so the UI can say "Fri Jul 17" instead
        # of implying the move happened today.
        "day_change_session": session_date.isoformat() if session_date else None,
        "day_high": quote.get("day_high"),
        "day_low": quote.get("day_low"),
        "week52_high": week52[0] if week52 else None,
        "week52_low": week52[1] if week52 else None,
        "total_gain": total_gain,
        "total_gain_pct": total_gain_pct,
        "exclude_from_net_worth": bool(h.exclude_from_net_worth or False),
        "is_favorited": bool(h.is_favorited or False),
        "has_trades": has_trades,
    }


def _trade_dict(t: Trade) -> dict:
    return {
        "id": t.id,
        "holding_id": t.holding_id,
        "trade_date": t.trade_date.isoformat(),
        "action": t.action,
        "shares": float(t.shares),
        "price_per_share": float(t.price_per_share) if t.price_per_share is not None else None,
        "amount": float(t.amount) if t.amount is not None else None,
        "split_ratio": float(t.split_ratio) if t.split_ratio is not None else None,
        "is_qualified": t.is_qualified,
        "notes": t.notes,
    }


def _validate_trade(body: TradeCreate) -> None:
    """Per-action field validation for trade creation."""
    if body.action not in TRADE_ACTIONS:
        raise HTTPException(status_code=400, detail=f"action must be one of: {TRADE_ACTIONS}")
    if body.action in ("buy", "sell"):
        if body.shares <= 0:
            raise HTTPException(status_code=400, detail="shares must be positive")
    elif body.action == "split":
        if not body.split_ratio or body.split_ratio <= 0:
            raise HTTPException(status_code=400, detail="split_ratio must be positive")
    else:  # income actions: dividend / reinvest / interest / capgain
        if not body.amount or body.amount <= 0:
            raise HTTPException(status_code=400, detail="amount must be positive")
        if body.action == "reinvest" and body.shares <= 0:
            raise HTTPException(status_code=400, detail="reinvest requires shares purchased")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
async def list_holdings(
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    """Every investment position, one row each, from the same book the
    Dashboard and Portfolio total (modules/portfolio/positions).

    Rows are holdings in every account — a 401(k), an HSA, a fund with no
    ticker — plus one Cash row per linked account, manual tracker funds, 529
    plan funds, option grants, and the balance of an account nothing
    itemises. The rows not excluded from net worth add up to the Dashboard's
    investment value.
    """
    from app.modules.portfolio.positions import (
        build_investment_book, investment_totals, position_rows,
    )

    book = await build_investment_book(db, user.id)
    totals = investment_totals(book)

    # A sold-out position is kept at zero shares rather than deleted, so its
    # cost basis stays, but it is not a holding any more. Rows with trades stay reachable through the account's
    # trade history, which is where a closed position belongs.
    holdings = [h for h in book.holdings if float(h.shares or 0) != 0]

    # Batch-check which holdings have trades
    looked_up = holdings
    holding_ids = [h.id for h in looked_up]
    trade_counts: dict[int, int] = {}
    if holding_ids:
        rows = (await db.execute(
            select(Trade.holding_id, func.count(Trade.id).label("cnt"))
            .where(Trade.holding_id.in_(holding_ids))
            .group_by(Trade.holding_id)
        )).all()
        trade_counts = {r.holding_id: r.cnt for r in rows}

    # Each security's two most recent daily closes (most recent first): the
    # day-change baseline depends on which session the price belongs to — see
    # _session_delta. Only for market tickers; a plan fund's stored "closes"
    # are the institution's marks, which say nothing about a trading session.
    sec_ids = [h.security_id for h in looked_up if h.security_id is not None]
    quoted_sec_ids = [
        h.security_id for h in looked_up
        if h.security_id is not None and h.security.ticker
    ]
    closes_by_sec: dict[int, list[tuple[date, float]]] = {}
    if quoted_sec_ids:
        # A close dated after today, or on a weekend for a symbol that does not
        # trade then, is a stray row an off-hours refresh wrote under the
        # server's UTC date. It repeats the previous session's close, so taking
        # it as a session zeroes every day change.
        today = market_today()
        weekend_ok = {
            h.security_id for h in looked_up
            if h.security_id is not None and trades_weekends(h.security.ticker, h.security.type)
        }
        cutoff = today - timedelta(days=10)
        ph_rows = (await db.execute(
            select(PriceHistory.security_id, PriceHistory.as_of, PriceHistory.close)
            .where(
                and_(
                    PriceHistory.security_id.in_(quoted_sec_ids),
                    PriceHistory.as_of >= cutoff,
                )
            )
            .order_by(PriceHistory.security_id, PriceHistory.as_of.desc())
        )).all()
        for sec_id, as_of, close in ph_rows:
            if close is None or as_of > today:
                continue
            if as_of.weekday() >= 5 and sec_id not in weekend_ok:
                continue
            bucket = closes_by_sec.setdefault(sec_id, [])
            if len(bucket) < 2:
                bucket.append((as_of, float(close)))

    # 52-week range from the daily-refreshed security_info table.
    week52_by_sec: dict[int, tuple[float | None, float | None]] = {}
    if sec_ids:
        info_rows = (await db.execute(
            select(SecurityInfo.security_id, SecurityInfo.week52_high, SecurityInfo.week52_low)
            .where(SecurityInfo.security_id.in_(sec_ids))
        )).all()
        week52_by_sec = {
            sid: (float(hi) if hi is not None else None, float(lo) if lo is not None else None)
            for sid, hi, lo in info_rows
        }

    if book.stale_tickers:
        background_tasks.add_task(refresh_symbols, list(book.stale_tickers))

    results = []
    for h in holdings:
        priced = book.prices[h.id]
        ticker = h.security.ticker
        quote = dict(book.quotes.get(ticker) or {}) if ticker and priced.source in ("live", "close") else {}
        # The book's price is the price: a quote dict only adds day change.
        quote["price"] = priced.price
        quote.setdefault("day_change", 0.0)
        quote.setdefault("day_change_pct", 0.0)
        av = totals.account_values.get(h.account_id)
        row = _enrich(
            h, quote, has_trades=trade_counts.get(h.id, 0) > 0,
            closes=closes_by_sec.get(h.security_id) if priced.source in ("live", "close") else None,
            week52=week52_by_sec.get(h.security_id),
        )
        account_excluded = bool(h.account and h.account.exclude_from_net_worth)
        row.update({
            "row_key": f"h:{h.id}",
            "kind": "holding",
            "price_source": priced.source,
            "price_as_of": priced.as_of.isoformat() if priced.as_of else None,
            "value_source": av.value_source if av else "positions",
            # Counts only when neither the holding nor its account is excluded;
            # the drawer edits the holding's own flag.
            "exclude_from_net_worth": bool(h.exclude_from_net_worth) or account_excluded,
            "holding_excluded": bool(h.exclude_from_net_worth),
            "account_excluded": account_excluded,
        })
        results.append(row)

    results.extend(position_rows(book, totals))
    return results


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_holding(
    body: HoldingCreate,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    acct = await db.scalar(
        select(Account).where(Account.id == body.account_id, Account.user_id == user.id)
    )
    if not acct:
        raise HTTPException(status_code=404, detail="Account not found")

    if body.security.type not in SECURITY_TYPES:
        raise HTTPException(status_code=400, detail=f"Invalid type. Must be one of: {SECURITY_TYPES}")

    if body.lot_method not in LOT_METHODS:
        raise HTTPException(status_code=400, detail=f"Invalid lot_method. Must be one of: {LOT_METHODS}")

    # Find or create security
    ticker = body.security.ticker.upper() if body.security.ticker else None
    security = None
    if ticker:
        security = await db.scalar(select(Security).where(Security.ticker == ticker))

    security_created = False
    if not security:
        security = Security(
            ticker=ticker,
            name=body.security.name,
            type=body.security.type,
            expense_ratio=body.security.expense_ratio,
        )
        db.add(security)
        await db.flush()
        security_created = True
    elif security.expense_ratio is None and body.security.expense_ratio is not None:
        # Shared row: fill an empty expense ratio, never replace one.
        security.expense_ratio = body.security.expense_ratio

    holding = Holding(
        account_id=body.account_id,
        security_id=security.id,
        shares=body.shares,
        cost_basis_total=body.cost_basis_total,
        acquired_at=body.acquired_at,
        lot_method=body.lot_method,
    )
    db.add(holding)
    await db.commit()
    await db.refresh(holding, ["account", "security"])

    ticker = holding.security.ticker
    if security_created and ticker:
        # First time we've seen this ticker: backfill a year of daily closes +
        # intraday bars right after the response, so charts work in seconds
        # instead of waiting for the next scheduled history pass.
        background_tasks.add_task(backfill_new_security, holding.security_id)
    if ticker and holding.security.expense_ratio is None:
        # A fund added by hand gets its expense ratio now, not the next night.
        # Whatever type was picked: a VTI saved as the default
        # "stock" is still a fund, and a real stock simply reports none.
        from app.modules.investments.expense_ratios import fill_expense_ratios_for
        background_tasks.add_task(fill_expense_ratios_for, [holding.security_id])
    quote = get_quote(ticker) if ticker else {"price": 0.0, "day_change": 0.0, "day_change_pct": 0.0}
    return _enrich(holding, quote, has_trades=False)


@router.patch("/{holding_id}")
async def update_holding(
    holding_id: int,
    body: HoldingUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await db.scalar(
        select(Holding)
        .where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
        .options(selectinload(Holding.account), selectinload(Holding.security))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    # `exclude_unset`, not `exclude_none`: the two say different things and the
    # difference is the whole bug. With `exclude_none` a null was silently
    # dropped, so "I don't know what this cost" was inexpressible — the form's
    # only way to clear the field was to send 0, which means "it cost nothing",
    # and the holdings table then reported the entire market value as gain.
    #
    # Unset fields are still left alone; only a field the client actually sent
    # as null clears. Restricted to cost_basis_total, since every other column
    # here is non-nullable and a null would be a client bug rather than intent.
    update_data = body.model_dump(exclude_unset=True)
    update_data = {
        k: v for k, v in update_data.items()
        if v is not None or k == "cost_basis_total"
    }
    # Shares *and* cost basis are derived from the trade history when there is
    # one — `recalc_holding` computes both from the same replay, and the UI
    # marks both "auto". Only shares were protected here, so the drawer's
    # "Save Changes" wrote its cost field straight over a figure the trades had
    # just produced.
    #
    # That is not a hypothetical stale-form race. The drawer fills its form when
    # it opens and does not refill it after trades are saved, so the value it
    # sends is whatever the box held beforehand — for a position created with
    # the box empty, zero. For example, 100 shares with a $5,000 buy in the
    # history and a Total Cost Basis of $0, which rendered the whole $4,000
    # market value as gain.
    trade_count = await db.scalar(
        select(func.count(Trade.id)).where(Trade.holding_id == holding_id)
    )
    has_trades = (trade_count or 0) > 0
    if has_trades:
        for derived in ("shares", "cost_basis_total"):
            update_data.pop(derived, None)

    expense_ratio = update_data.pop("expense_ratio", None)
    if expense_ratio is not None:
        if holding.security.expense_ratio is not None:
            raise HTTPException(
                status_code=409,
                detail="This fund already has an expense ratio. Contact support if it looks wrong.",
            )
        holding.security.expense_ratio = expense_ratio

    for field, value in update_data.items():
        setattr(holding, field, value)

    await db.commit()
    ticker = holding.security.ticker
    quote = get_quote(ticker) if ticker else {"price": 0.0, "day_change": 0.0, "day_change_pct": 0.0}
    return _enrich(holding, quote, has_trades=has_trades)


@router.delete("/{holding_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_holding(
    holding_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await db.scalar(
        select(Holding).where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    await db.delete(holding)
    await db.commit()


# ── Trade sub-resource ────────────────────────────────────────────────────────

@router.get("/{holding_id}/trades")
async def list_trades(
    holding_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await db.scalar(
        select(Holding).where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trades = (await db.scalars(
        select(Trade).where(Trade.holding_id == holding_id).order_by(Trade.trade_date, Trade.id)
    )).all()
    return [_trade_dict(t) for t in trades]


@router.post("/{holding_id}/trades", status_code=status.HTTP_201_CREATED)
async def create_trade(
    holding_id: int,
    body: TradeCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    holding = await db.scalar(
        select(Holding)
        .where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
        .options(selectinload(Holding.account), selectinload(Holding.security))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    _validate_trade(body)

    is_income = body.action in INCOME_ACTIONS
    is_qualified = body.is_qualified
    if is_income and is_qualified is None:
        # Default: dividends on stocks/ETFs are typically qualified; interest never is.
        is_qualified = (
            body.action in ("dividend", "reinvest")
            and holding.security.type in ("stock", "etf")
        )

    # Keep shares from a statement or the edit form once trades take over.
    await ensure_opening_trade(holding, body.trade_date, db)

    trade = Trade(
        holding_id=holding_id,
        trade_date=body.trade_date,
        action=body.action,
        # Cash income and splits carry no share delta of their own
        shares=body.shares if body.action in ("buy", "sell", "reinvest") else 0,
        price_per_share=body.price_per_share if body.action in ("buy", "sell", "reinvest") else None,
        amount=body.amount if is_income else None,
        split_ratio=body.split_ratio if body.action == "split" else None,
        is_qualified=is_qualified if is_income else None,
        notes=body.notes,
    )
    db.add(trade)
    await db.flush()

    # Recalculate shares and cost basis from all trades
    await recalc_holding(holding_id, db)
    await db.commit()
    await db.refresh(trade)

    return _trade_dict(trade)


@router.delete("/{holding_id}/trades/{trade_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_trade(
    holding_id: int,
    trade_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    # Verify ownership via holding → account → user
    holding = await db.scalar(
        select(Holding).where(Holding.id == holding_id, Holding.account_id.in_(user_acct_ids))
    )
    if not holding:
        raise HTTPException(status_code=404, detail="Holding not found")

    trade = await db.scalar(
        select(Trade).where(Trade.id == trade_id, Trade.holding_id == holding_id)
    )
    if not trade:
        raise HTTPException(status_code=404, detail="Trade not found")

    await db.delete(trade)
    await db.flush()
    await recalc_holding(holding_id, db)
    await db.commit()

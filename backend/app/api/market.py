import asyncio
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Path
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.models.holding import Holding
from app.models.security import PriceHistory, Security
from app.models.user import User
from app.modules.investments.backfill import ensure_daily_coverage
from app.modules.investments.market_data import get_history, get_quote, get_symbol_search, get_ticker_detail
from app.modules.investments.refresh import refresh_and_persist

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/quote/{symbol}")
async def quote(
    symbol: str = Path(...),
    user: User = Depends(get_current_user),
):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, get_quote, symbol.upper())


@router.get("/search")
async def search(
    q: str = "",
    user: User = Depends(get_current_user),
):
    """Ticker/company-name typeahead for the ticker-lookup drawer — lets a
    user find a symbol by typing a company name (e.g. "apple") and disambiguate
    similarly-named results before picking one."""
    if len(q.strip()) < 1:
        return []
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, get_symbol_search, q)


@router.get("/detail/{symbol}")
async def detail(
    symbol: str = Path(...),
    user: User = Depends(get_current_user),
):
    """Ticker deep-dive payload: price, day/52-week range, analyst consensus,
    and recent news. Backed by an in-process cache (see get_ticker_detail) so
    this stays cheap even though it makes a few slow yfinance calls."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, get_ticker_detail, symbol.upper())


@router.get("/history/{symbol}")
async def history(
    symbol: str = Path(...),
    range: str = "90d",
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Daily close history, served from the DB for known securities.

    Coverage is ensured on demand (no-op when already stored), so this stays
    fast for held tickers and still backfills gaps — e.g. a prior_year request
    that predates what the scheduled refresh keeps. Unknown tickers (ad-hoc
    lookups) fall back to a live fetch without polluting the security table.
    """
    if range not in ("90d", "ytd", "12m", "prior_year"):
        raise HTTPException(status_code=400, detail="Invalid range. Use: 90d, ytd, 12m, prior_year")
    sym = symbol.upper()

    today = date.today()
    range_bounds = {
        "90d": (today - timedelta(days=90), None),
        "ytd": (date(today.year, 1, 1), None),
        "12m": (today - timedelta(days=365), None),
        "prior_year": (date(today.year - 1, 1, 1), date(today.year - 1, 12, 31)),
    }
    start, end = range_bounds[range]

    security = await db.scalar(select(Security).where(Security.ticker == sym))
    if security is None:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, get_history, sym, range)

    await ensure_daily_coverage(db, [security], start=start, refresh_tail=False)
    await db.commit()

    conditions = [
        PriceHistory.security_id == security.id,
        PriceHistory.as_of >= start,
        PriceHistory.close.isnot(None),
    ]
    if end is not None:
        conditions.append(PriceHistory.as_of <= end)
    rows = (await db.execute(
        select(PriceHistory.as_of, PriceHistory.close)
        .where(*conditions)
        .order_by(PriceHistory.as_of)
    )).all()
    return [{"date": str(as_of), "close": float(close), "volume": 0} for as_of, close in rows]


@router.post("/refresh")
async def refresh_all(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_acct_ids: list[int] = Depends(get_user_account_ids),
):
    securities = (await db.scalars(
        select(Security)
        .join(Holding, Holding.security_id == Security.id)
        .where(Holding.account_id.in_(user_acct_ids), Security.ticker.isnot(None))
        .distinct()
    )).all()

    refreshed = await refresh_and_persist(db, securities)
    return {"refreshed": refreshed}

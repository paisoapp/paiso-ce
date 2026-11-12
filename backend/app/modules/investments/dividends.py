"""Shared dividend-history sync: upsert a security's per-share dividend
payments into ``security_dividend`` and stamp ``dividends_synced_at``.

Used by three callers, all of which fetch the (blocking) yfinance history in a
threadpool and hand the rows here so this stays pure DB work:
  - the weekly ``refresh_dividend_history`` scheduled job (all held securities),
  - ``backfill_new_security`` (immediately after a new ticker is added),
  - the on-demand ``POST /api/holdings/{id}/refresh-dividends`` endpoint.
"""
from datetime import datetime, timedelta, timezone

from app.core.upsert import dialect_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.security import Security, SecurityDividend

# Per-security cooldown for the on-demand refresh. Dividend data is global (the
# same for every holder), so once a day is plenty and keeps yfinance traffic low.
DIVIDEND_SYNC_COOLDOWN = timedelta(hours=24)


def utcnow_naive() -> datetime:
    """Naive UTC, matching how other timestamps in this codebase are stored."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_recently_synced(security: Security, *, now: datetime | None = None) -> bool:
    if security.dividends_synced_at is None:
        return False
    now = now or utcnow_naive()
    return (now - security.dividends_synced_at) < DIVIDEND_SYNC_COOLDOWN


async def upsert_dividends(
    db: AsyncSession,
    security: Security,
    rows: list[tuple],
) -> int:
    """Upsert (ex_date, amount, price_hint) rows and stamp dividends_synced_at.

    Keyed on (security_id, ex_date), so re-syncing full history is idempotent.
    Does not commit — the caller owns the transaction.
    """
    for ex_date, amount, price_hint in rows:
        stmt = dialect_insert(SecurityDividend).values(
            security_id=security.id, ex_date=ex_date,
            amount_per_share=amount, price_hint=price_hint,
        ).on_conflict_do_update(
            index_elements=["security_id", "ex_date"],
            set_={"amount_per_share": amount, "price_hint": price_hint},
        )
        await db.execute(stmt)
    security.dividends_synced_at = utcnow_naive()
    return len(rows)

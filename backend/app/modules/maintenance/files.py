"""Files in storage that no row owns any more.

Receipts are stored at ``attachments/<user_id>/<txn_id>/<stored_name>`` and
counted against the quota through their ``transaction_attachment`` rows. A
transaction deleted by a path that removed only the rows left its files on
disk, outside the quota, for good. Staged CSV statements
(``imports/<user_id>/<uuid>``) are deleted on commit, but a wizard abandoned
halfway left its file behind.

Two parts:

- :func:`delete_attachment_files` is called by every path that deletes
  transactions, before the rows go, so the files go with them.
- :func:`sweep_orphaned_files` runs nightly and removes whatever still has no
  owner: staged CSVs older than a day, attachment files no row names, and the
  folder staged CSVs used before they moved to storage.
"""
import time
from pathlib import Path

import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.storage import get_storage
from app.models.transaction import TransactionAttachment

log = structlog.get_logger()

#: A staged CSV older than this was abandoned: the wizard takes minutes.
STAGED_CSV_MAX_AGE_SECS = 24 * 3600
#: An attachment file younger than this may belong to an upload whose row is
#: not committed yet, so the sweep leaves it alone.
ATTACHMENT_GRACE_SECS = 3600


def attachment_key(user_id: int, txn_id: int, stored_name: str) -> str:
    return f"attachments/{user_id}/{txn_id}/{stored_name}"


async def delete_attachment_files(db: AsyncSession, transaction_ids: list[int]) -> int:
    """Delete the stored files of these transactions' attachments. Call it
    before deleting the rows. A storage error is logged, never raised: the
    caller's delete must not fail over a file, and the nightly sweep removes
    anything left. Returns the number of files deleted."""
    if not transaction_ids:
        return 0
    rows = (await db.execute(
        select(
            TransactionAttachment.user_id,
            TransactionAttachment.transaction_id,
            TransactionAttachment.stored_name,
        ).where(TransactionAttachment.transaction_id.in_(transaction_ids))
    )).all()
    storage = get_storage()
    deleted = 0
    for user_id, txn_id, stored_name in rows:
        try:
            await storage.delete(attachment_key(user_id, txn_id, stored_name))
            deleted += 1
        except Exception:  # noqa: BLE001
            log.warning("files.attachment_delete_failed", transaction_id=txn_id, exc_info=True)
    return deleted


async def sweep_orphaned_files(db: AsyncSession, now: float | None = None) -> dict:
    """Remove stored files that nothing owns. Safe to run at any time."""
    now = time.time() if now is None else now
    storage = get_storage()
    out = {"staged_csvs": 0, "attachments": 0, "legacy_uploads": 0}

    for key, modified in await storage.list_prefix("imports/"):
        if now - modified > STAGED_CSV_MAX_AGE_SECS:
            await storage.delete(key)
            out["staged_csvs"] += 1

    owned = {
        attachment_key(u, t, n)
        for u, t, n in (await db.execute(select(
            TransactionAttachment.user_id,
            TransactionAttachment.transaction_id,
            TransactionAttachment.stored_name,
        ))).all()
    }
    for key, modified in await storage.list_prefix("attachments/"):
        if key not in owned and now - modified > ATTACHMENT_GRACE_SECS:
            await storage.delete(key)
            out["attachments"] += 1

    # Staged CSVs lived here, beside the SQLite path, until they moved to
    # storage. Nothing reads this folder now.
    legacy = Path(settings.sqlite_path).parent / "uploads"
    if legacy.is_dir():
        for p in legacy.iterdir():
            if p.is_file() and now - p.stat().st_mtime > STAGED_CSV_MAX_AGE_SECS:
                p.unlink(missing_ok=True)
                out["legacy_uploads"] += 1

    log.info("files.sweep_done", **out)
    return out

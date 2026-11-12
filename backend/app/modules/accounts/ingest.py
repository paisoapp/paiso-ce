"""Shared transaction ingest for the file-import paths.

Every import path in ``api/imports.py`` (the mapped CSV wizard, bank CSV,
and OFX/QFX) used to dedupe with a
``SELECT`` per row. That is N+1 (a 5,000-row statement meant 5,000 queries)
and it is racy: two concurrent imports could both find nothing and both
insert.

``(account_id, external_id)`` is now a real partial unique index, so the
insert can carry ``ON CONFLICT DO NOTHING`` and let the database arbitrate.
``RETURNING`` then tells us exactly which rows were new, which is what the
wizard reports back to the user.
"""
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.upsert import dialect_insert
from app.models.transaction import Transaction

log = structlog.get_logger()


async def insert_new_transactions(
    db: AsyncSession, rows: list[dict]
) -> tuple[int, int, list[int]]:
    """Insert `rows`, skipping any whose (account_id, external_id) already exists.

    Returns ``(imported, skipped, inserted_ids)``. Rows with no ``external_id`` are always
    inserted — a manually entered transaction has no dedupe key, and the
    unique index is partial precisely so those NULLs never collide.
    """
    if not rows:
        return 0, 0, []

    # Within a single file the same external_id can legitimately repeat (a
    # duplicated statement line). ON CONFLICT does not fire for rows inserted
    # in the same statement, so collapse them here first.
    seen: set[tuple] = set()
    deduped: list[dict] = []
    for row in rows:
        external_id = row.get("external_id")
        if external_id is not None:
            key = (row.get("account_id"), external_id)
            if key in seen:
                continue
            seen.add(key)
        deduped.append(row)

    stmt = (
        dialect_insert(Transaction)
        .values(deduped)
        .on_conflict_do_nothing(
            index_elements=["account_id", "external_id"],
            # The index is partial, so Postgres only infers it when the
            # predicate matches; without this it raises
            # "no unique or exclusion constraint matching the ON CONFLICT".
            index_where=text("external_id IS NOT NULL"),
        )
        .returning(Transaction.id)
    )
    inserted_ids = (await db.execute(stmt)).scalars().all()
    return len(inserted_ids), len(rows) - len(inserted_ids), list(inserted_ids)


async def pair_transfers(
    db: AsyncSession, user_id: int, transaction_ids: list[int]
) -> None:
    """Look for transfer counterparts among freshly imported rows.

    Deliberately swallowing failures: pairing is an enhancement, and an
    import that succeeded must not be reported as failed because the matcher
    tripped over something.

    Callers run this after committing the import. The rollback below then
    undoes only the matcher's own partial work; called before the commit it
    would also drop the rows just inserted while the caller still reported
    them as imported.
    """
    if not transaction_ids:
        return
    from app.modules.budgeting.transfer_matcher import match_transfers

    try:
        await match_transfers(db, user_id, transaction_ids=transaction_ids)
    except Exception:  # noqa: BLE001
        await db.rollback()
        log.warning("ingest.transfer_match_failed", user_id=user_id, exc_info=True)

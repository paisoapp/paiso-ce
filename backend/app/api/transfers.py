"""Review and control of transfer pairing.

The matcher only ever *suggests*; nothing here happens without the user. See
``app/modules/budgeting/transfer_matcher.py`` for why it is deliberately
conservative, and ``app/models/transfer.py`` for the constraints that make a
double-booked transaction impossible rather than merely unlikely.
"""
import structlog
from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_user_account_ids
from app.core.database import get_db
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.transfer import TransferLink
from app.models.user import User
from app.modules.budgeting import transfer_matcher

log = structlog.get_logger()

router = APIRouter(prefix="/api/transfers", tags=["transfers"])


async def _link_out(db: AsyncSession, link: TransferLink) -> dict:
    result = (await db.execute(
        select(Transaction.id, Transaction.description, Transaction.date_posted,
               Transaction.amount, Account.display_name)
        .join(Account, Account.id == Transaction.account_id)
        .where(Transaction.id.in_([link.outflow_txn_id, link.inflow_txn_id]))
    )).all()
    rows = {row[0]: row for row in result}

    def side(txn_id: int) -> dict | None:
        row = rows.get(txn_id)
        if row is None:
            return None
        return {
            "transaction_id": row[0],
            "description": row[1],
            "date_posted": row[2].isoformat() if row[2] else None,
            "amount": float(row[3]),
            "account_name": row[4],
        }

    return {
        "id": link.id,
        "status": link.status,
        "kind": link.kind,
        "source": link.source,
        "confidence": float(link.confidence),
        "amount": float(link.amount),
        "matched_on": link.matched_on,
        "outflow": side(link.outflow_txn_id),
        "inflow": side(link.inflow_txn_id),
    }


async def _get_link(db: AsyncSession, user: User, link_id: int) -> TransferLink:
    link = await db.get(TransferLink, link_id)
    if link is None or link.user_id != user.id:
        raise HTTPException(status_code=404, detail="Transfer link not found")
    return link


@router.get("/links")
async def list_links(
    status_filter: str = Query("suggested", alias="status"),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Transfer links, newest first. Defaults to the review queue.

    Reading the queue reconciles it first. The matcher's rules live in code and
    change with a deploy, but the rows were written under whatever rules
    applied when they were matched — and reconciliation used to happen only
    inside ``match_transfers``, on a transaction sync or the 03:30 rematch. So
    a fix could ship, deploy cleanly, and the user would still be looking at a
    queue built by the old rules, with no way to tell the difference from the
    fix not working. That happened three times in a row.

    Doing it on read means the queue is never staler than the moment you looked
    at it. It is bounded work: the passes only touch rows still marked
    ``suggested``, which is the set being displayed anyway.
    """
    if "suggested" in status_filter:
        await transfer_matcher.reconcile_suggestions(db, user.id)

    query = select(TransferLink).where(TransferLink.user_id == user.id)
    if status_filter != "all":
        wanted = [s.strip() for s in status_filter.split(",") if s.strip()]
        query = query.where(TransferLink.status.in_(wanted))
    links = (await db.scalars(
        query.order_by(TransferLink.confidence.desc(), TransferLink.id.desc())
        .limit(limit)
    )).all()
    return [await _link_out(db, link) for link in links]


@router.post("/links/{link_id}/confirm")
async def confirm_link(
    link_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Accept a suggested pair.

    Both legs are moved into a transfer-treatment category so the movement
    stops being counted as spending — except where the user chose the category
    themselves, which always wins.
    """
    from datetime import datetime, timezone

    link = await _get_link(db, user, link_id)
    link.status = "confirmed"
    link.confirmed_at = datetime.now(timezone.utc)
    changed = await transfer_matcher.apply_transfer_categories(db, link)
    await db.commit()
    log.info("transfers.confirmed", user_id=user.id, link=link.id, recategorized=changed)
    return await _link_out(db, link)


@router.post("/links/{link_id}/reject")
async def reject_link(
    link_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Dismiss a suggestion.

    Kept as a tombstone rather than deleted, so the matcher never proposes
    this exact pair again — while both legs stay free to pair with something
    else.
    """
    link = await _get_link(db, user, link_id)
    link.status = "rejected"
    await db.commit()
    return await _link_out(db, link)


class LinkCreate(BaseModel):
    outflow_transaction_id: int
    inflow_transaction_id: int


@router.post("/links", status_code=status.HTTP_201_CREATED)
async def create_link(
    body: LinkCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
    user_account_ids: list[int] = Depends(get_user_account_ids),
):
    """Pair two transactions by hand."""
    rows = (await db.scalars(
        select(Transaction).where(
            Transaction.id.in_([body.outflow_transaction_id, body.inflow_transaction_id]),
            Transaction.account_id.in_(user_account_ids),
        )
    )).all()
    found = {t.id: t for t in rows}
    outflow = found.get(body.outflow_transaction_id)
    inflow = found.get(body.inflow_transaction_id)
    if outflow is None or inflow is None:
        raise HTTPException(status_code=404, detail="Transaction not found")
    if outflow.id == inflow.id:
        raise HTTPException(status_code=400, detail="A transaction cannot pair with itself")
    if outflow.account_id == inflow.account_id:
        raise HTTPException(
            status_code=400, detail="Both legs are in the same account"
        )
    if outflow.amount >= 0 or inflow.amount <= 0:
        raise HTTPException(
            status_code=400,
            detail="A transfer needs one outgoing and one incoming transaction",
        )

    existing = await db.scalar(
        select(TransferLink).where(
            TransferLink.user_id == user.id,
            TransferLink.status != "rejected",
            or_(
                TransferLink.outflow_txn_id.in_([outflow.id, inflow.id]),
                TransferLink.inflow_txn_id.in_([outflow.id, inflow.id]),
            ),
        )
    )
    if existing is not None:
        raise HTTPException(
            status_code=409, detail="One of these transactions is already linked"
        )

    from datetime import datetime, timezone

    link = TransferLink(
        user_id=user.id,
        outflow_txn_id=outflow.id,
        inflow_txn_id=inflow.id,
        amount=abs(outflow.amount),
        kind="account_transfer",
        confidence=1.0,
        status="confirmed",
        source="manual",
        matched_on="manual",
        confirmed_at=datetime.now(timezone.utc),
    )
    db.add(link)
    await db.flush()
    await transfer_matcher.apply_transfer_categories(db, link)
    await db.commit()
    return await _link_out(db, link)


@router.delete("/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_link(
    link_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Unlink a pair entirely.

    Deleted rather than tombstoned: unlinking says "these were never a pair",
    so the matcher is free to consider them again. Use reject to say "stop
    suggesting this".
    """
    link = await _get_link(db, user, link_id)
    await db.delete(link)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/rematch")
async def rematch(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Re-run the matcher over this user's unlinked transactions."""
    return await transfer_matcher.match_transfers(db, user.id)

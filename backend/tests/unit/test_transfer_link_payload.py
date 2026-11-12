"""What a paired transaction tells the client about its counterpart.

The table used to carry a "LINKED" badge whose whole content was "this is
paired". That is the one thing the Category column already implies. What was
nowhere — and matters more now that the matcher confirms pairs on its own — is
*which* transaction it was paired with and *why*, which is what makes an
automated recategorisation reviewable.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api.transactions import _transfer_links_for
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.transfer import TransferLink
from app.models.user import User

pytestmark = pytest.mark.unit


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield session
    finally:
        await engine.dispose()


async def _pair(db, status="confirmed", source="auto", matched_on="amount+1d+names-destination"):
    user = User(email="t@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    checking = Account(user_id=user.id, account_type="checking",
                       display_name="Everyday Checking (0001)", currency="USD")
    card = Account(user_id=user.id, account_type="credit_card",
                   display_name="Rewards Visa (0042)", currency="USD")
    db.add_all([checking, card])
    await db.flush()
    out = Transaction(account_id=checking.id, date_posted=date(2026, 3, 8),
                      amount=Decimal("-1250.00"), description="CARD AUTOPAY",
                      transaction_type="debit")
    inn = Transaction(account_id=card.id, date_posted=date(2026, 3, 9),
                      amount=Decimal("1250.00"), description="PAYMENT THANK YOU",
                      transaction_type="credit")
    db.add_all([out, inn])
    await db.flush()
    db.add(TransferLink(user_id=user.id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
                        amount=Decimal("1250.00"), kind="credit_card_payment",
                        confidence=Decimal("1.0"), status=status, source=source,
                        matched_on=matched_on))
    await db.commit()
    return user, out, inn


async def test_the_payload_names_the_counterpart_transaction(db):
    user, out, inn = await _pair(db)

    payload = await _transfer_links_for(db, [out.id])
    side = payload[out.id]

    assert side["counterpart_account_name"] == "Rewards Visa (0042)"
    assert side["counterpart_date"] == "2026-03-09"
    assert side["counterpart_amount"] == pytest.approx(1250.00)
    assert side["counterpart_description"] == "PAYMENT THANK YOU"


async def test_it_says_who_decided_and_on_what(db):
    """An auto-confirmed pair recategorised two transactions without anyone
    approving it. The drawer has to be able to say why before offering undo."""
    user, out, _ = await _pair(db)

    side = (await _transfer_links_for(db, [out.id]))[out.id]
    assert side["source"] == "auto"
    assert "names-destination" in side["matched_on"]
    assert side["link_id"] is not None, "the id the unlink action needs"


async def test_both_legs_describe_the_other(db):
    user, out, inn = await _pair(db)

    payload = await _transfer_links_for(db, [out.id, inn.id])
    assert payload[out.id]["counterpart_transaction_id"] == inn.id
    assert payload[inn.id]["counterpart_transaction_id"] == out.id
    assert payload[inn.id]["counterpart_account_name"] == "Everyday Checking (0001)"


async def test_an_unpaired_transaction_carries_nothing(db):
    user, out, _ = await _pair(db)
    solo = Transaction(account_id=out.account_id, date_posted=date(2026, 9, 1),
                       amount=Decimal("-12.00"), description="COFFEE",
                       transaction_type="debit")
    db.add(solo)
    await db.commit()

    assert solo.id not in await _transfer_links_for(db, [solo.id])

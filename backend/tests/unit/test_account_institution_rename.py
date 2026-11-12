"""Renaming an institution across the accounts that share it.

`Institution.accounts` is a one-to-many. Declared as a bare `Mapped[list]`,
SQLAlchemy could not read an element type out of it and fell back to
`uselist=False` — so the relationship behaved as a scalar, and `back_populates`
assigned through it. Pointing a second account at an institution then displaced
the first out of that slot and nulled its `institution_id`.
"""
import pytest
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.api import accounts as api
from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account, Institution
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


async def _credit_union(db, count=3):
    user = User(email="i@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    inst = Institution(name="Example CU")
    db.add(inst)
    await db.flush()
    ids = []
    for n in range(count):
        acct = Account(user_id=user.id, account_type="checking",
                       display_name=f"Account {n}", currency="USD",
                       institution_id=inst.id)
        db.add(acct)
        await db.flush()
        ids.append(acct.id)
    await db.commit()
    return user, ids


async def _names(db, user):
    rows = (await db.scalars(
        select(Account).where(Account.user_id == user.id).order_by(Account.id)
        .options(selectinload(Account.institution))
    )).all()
    return [a.institution.name if a.institution else None for a in rows]


async def test_renaming_one_institution_does_not_blank_another(db):
    """Several accounts at one credit union, renamed one at a time."""
    user, ids = await _credit_union(db, count=3)

    for i, acct_id in enumerate(ids):
        await api.update_account(
            acct_id,
            api.AccountUpdate(display_name=f"Example CU {i}",
                              institution_name="Example Credit Union"),
            db, user,
        )

    assert await _names(db, user) == ["Example Credit Union"] * 3


async def test_renaming_the_account_alone_keeps_the_institution(db):
    user, ids = await _credit_union(db, count=2)

    await api.update_account(
        ids[0], api.AccountUpdate(display_name="Everyday Checking"), db, user
    )

    assert await _names(db, user) == ["Example CU", "Example CU"]


async def test_clearing_one_institution_leaves_the_others(db):
    """An explicit clear is still a clear — for that account only."""
    user, ids = await _credit_union(db, count=3)

    await api.update_account(
        ids[1], api.AccountUpdate(institution_name=""), db, user
    )

    assert await _names(db, user) == ["Example CU", None, "Example CU"]

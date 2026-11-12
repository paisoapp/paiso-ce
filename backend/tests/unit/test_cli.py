"""Owner commands (app/cli.py)."""
import io

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app import cli
from app.core.database import Base
from app.core.security import hash_password, verify_password
from app.models.user import User, UserBackupCode

pytestmark = pytest.mark.unit


@pytest.fixture
async def maker(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'cli.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(cli, "AsyncSessionLocal", maker)
    async with maker() as db:
        user = User(email="Ada@example.com", hashed_password=hash_password("old-password-1"),
                    token_family="fam0", totp_enabled=True, totp_secret="enc:x",
                    mfa_required=True, failed_logins=4)
        db.add(user)
        await db.flush()
        db.add(UserBackupCode(user_id=user.id, code_hash="h"))
        await db.commit()
    yield maker
    await engine.dispose()


async def _user(maker):
    async with maker() as db:
        return await db.scalar(select(User))


async def test_reset_password_sets_it_and_signs_out(maker, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("a-new-long-password-9\n"))
    await cli.reset_password("ada@example.com")
    user = await _user(maker)
    assert verify_password("a-new-long-password-9", user.hashed_password)
    assert user.token_family != "fam0" and user.failed_logins == 0


async def test_a_weak_password_changes_nothing(maker, monkeypatch):
    monkeypatch.setattr("sys.stdin", io.StringIO("short\n"))
    with pytest.raises(SystemExit):
        await cli.reset_password("ada@example.com")
    user = await _user(maker)
    assert verify_password("old-password-1", user.hashed_password)


async def test_an_unknown_email_changes_nothing(maker):
    with pytest.raises(SystemExit, match="No account"):
        await cli.reset_mfa("nobody@example.com")


async def test_reset_mfa_turns_it_off_and_drops_recovery_codes(maker):
    await cli.reset_mfa("ada@example.com")
    user = await _user(maker)
    assert not user.totp_enabled and user.totp_secret is None and not user.mfa_required
    assert user.token_family != "fam0"
    async with maker() as db:
        assert (await db.scalars(select(UserBackupCode))).all() == []

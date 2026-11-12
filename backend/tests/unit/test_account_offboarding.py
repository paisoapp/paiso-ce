"""The password policy, which has to be the same rule on every path that sets
a password, and the terms version every sign-up records."""
import pytest

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401
from app.core.validation import MAX_PASSWORD_LENGTH, password_problem


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


# ── Password policy ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("password", ["", "short", "1234567", "       ", "password123", "QWERTY123"])
def test_unacceptable_passwords_are_rejected(password):
    assert password_problem(password) is not None


@pytest.mark.parametrize("password", ["correct horse battery", "aVerySolid!Pass9", "8charsss"])
def test_acceptable_passwords_pass(password):
    assert password_problem(password) is None


def test_password_cannot_be_the_email_or_its_local_part():
    assert password_problem("user@example.com", "user@example.com") is not None
    assert password_problem("Ada.Lovelace", "ada.lovelace@example.com") is not None
    # A different address is irrelevant to this user's password.
    assert password_problem("someoneelse@example.com", "user@example.com") is None


def test_absurdly_long_passwords_are_rejected():
    """Argon2 hashes whatever it is handed, so length is a cost lever."""
    assert password_problem("a" * (MAX_PASSWORD_LENGTH + 1)) is not None
    assert password_problem("a" * MAX_PASSWORD_LENGTH) is None


# ── Terms acceptance ────────────────────────────────────────────────────────


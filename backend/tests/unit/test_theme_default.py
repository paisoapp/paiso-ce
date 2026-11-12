"""A new account has no stored theme, so this device's own look stands."""
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api.settings import get_profile
from app.core.database import Base
from app.models.settings import UserSettings
from app.models.user import User

pytestmark = pytest.mark.unit


async def test_a_new_account_has_no_stored_theme(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 't.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, expire_on_commit=False)() as db:
        user = User(email="a@example.com", hashed_password="x", token_family="f")
        db.add(user)
        await db.flush()
        db.add(UserSettings(user_id=user.id))
        await db.commit()
        out = await get_profile(db=db, user=user)
    await engine.dispose()
    assert out["theme"] is None and out["theme_variant"] is None

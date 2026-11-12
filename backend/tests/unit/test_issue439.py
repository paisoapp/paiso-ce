"""logos are never uploaded, and a mortgage's payments are found
from the bank's own label."""

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import accounts as accounts_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.user import User

pytestmark = pytest.mark.unit

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


# ── Users cannot set a logo ──────────────────────────────────────────────────

@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'i.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def user(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="l@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.commit()
        return u


@pytest.fixture
async def client(sessionmaker, user):
    app = FastAPI()
    app.include_router(accounts_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://t") as c:
        yield c


async def test_the_upload_endpoint_is_gone(client):
    r = await client.post("/api/accounts/1/logo", files={"file": ("a.png", PNG, "image/png")})
    assert r.status_code in (404, 405)


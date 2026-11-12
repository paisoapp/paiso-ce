"""Fixes from the security review of the self-hosted edition."""
import time

import httpx
import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import assets as assets_api
from app.api import auth as auth_api
from app.api import transactions as transactions_api
from app.api.deps import get_current_user, get_user_account_ids
from app.core import ratelimit
from app.core.body_limit import BodyLimitMiddleware
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.user import User
from app.modules.aggregator.ofx_parser import parse_ofx_statements

pytestmark = pytest.mark.unit


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 's.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _client(sessionmaker, router, user, account_ids=()):
    app = FastAPI()
    app.include_router(router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_user_account_ids] = lambda: list(account_ids)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://t")


async def test_bulk_update_refuses_another_users_category(sessionmaker):
    async with sessionmaker() as db:
        me = User(email="me@example.com", hashed_password="x", token_family="f")
        other = User(email="other@example.com", hashed_password="x", token_family="g")
        db.add_all([me, other])
        await db.flush()
        acct = Account(user_id=me.id, display_name="Checking", account_type="checking")
        theirs = Category(user_id=other.id, name="Theirs", treatment="expense")
        db.add_all([acct, theirs])
        await db.flush()
        from datetime import date
        txn = Transaction(account_id=acct.id, date_posted=date(2026, 10, 1), amount=-5,
                          description="COFFEE")
        db.add(txn)
        await db.commit()
        ids = (me, acct.id, theirs.id, txn.id)

    me, acct_id, their_cat, txn_id = ids
    async with await _client(sessionmaker, transactions_api.router, me, [acct_id]) as c:
        r = await c.post("/api/transactions/bulk-update",
                         json={"transaction_ids": [txn_id], "category_id": their_cat})
    assert r.status_code == 404
    async with sessionmaker() as db:
        assert (await db.get(Transaction, txn_id)).category_id is None


async def test_totp_setup_cannot_replace_a_live_authenticator(sessionmaker):
    async with sessionmaker() as db:
        me = User(email="me@example.com", hashed_password="x", token_family="f",
                  totp_enabled=True, totp_secret="enc:old")
        db.add(me)
        await db.commit()
    async with await _client(sessionmaker, auth_api.router, me) as c:
        r = await c.post("/api/auth/totp/enroll")
    assert r.status_code == 409
    async with sessionmaker() as db:
        assert (await db.get(User, me.id)).totp_secret == "enc:old"


def _limited_app(max_bytes: int):
    app = FastAPI()

    @app.post("/echo")
    async def echo(request: Request):
        return PlainTextResponse(str(len(await request.body())))

    app.add_middleware(BodyLimitMiddleware, max_bytes=max_bytes)
    return app


async def test_a_body_over_the_limit_is_refused():
    transport = httpx.ASGITransport(app=_limited_app(100))
    async with httpx.AsyncClient(transport=transport, base_url="https://t") as c:
        assert (await c.post("/echo", content=b"x" * 50)).text == "50"
        assert (await c.post("/echo", content=b"x" * 101)).status_code == 413

        async def chunks():
            for _ in range(5):
                yield b"x" * 40

        # No Content-Length: the body is counted as it arrives.
        assert (await c.post("/echo", content=chunks())).status_code == 413


def test_expired_rate_limit_windows_are_swept(monkeypatch):
    monkeypatch.setattr(ratelimit, "_counts", {})
    monkeypatch.setattr(ratelimit, "_SWEEP_AT", 10)
    past = time.monotonic() - 1
    for i in range(10):
        ratelimit._counts[f"old:{i}"] = (1, past)
    ratelimit._incr("new", 60)
    assert set(ratelimit._counts) == {"new"}


@pytest.mark.parametrize("url", [
    "http://www.zillow.com/homedetails/1",
    "https://evil.example.com/x",
    "https://169.254.169.254/latest/meta-data",
    "https://www.zillow.com.evil.example.com/x",
])
def test_a_photo_url_must_be_https_to_an_allowed_host(url):
    with pytest.raises(HTTPException):
        assets_api._assert_allowed_host(url)


def test_an_allowed_photo_url_passes():
    assets_api._assert_allowed_host("https://www.zillow.com/homedetails/1")


async def test_a_redirect_off_the_allowed_hosts_is_stopped():
    with pytest.raises(HTTPException):
        await assets_api._check_redirect(httpx.Request("GET", "https://10.0.0.1/admin"))


def test_an_ofx_file_with_entities_is_not_read():
    bomb = (
        '<?xml version="1.0"?><!DOCTYPE OFX [<!ENTITY a "aaaaaaaaaa">'
        '<!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>'
        "<OFX><SIGNONMSGSRSV1>&b;</SIGNONMSGSRSV1></OFX>"
    )
    assert parse_ofx_statements(bomb) == []

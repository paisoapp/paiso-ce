"""Sign-in and session hardening.

#2  /totp/verify is enrolment only, and a TOTP code works once
A4  one recovery code cannot sign in twice, even concurrently
A5  one refresh token cannot be rotated twice, even concurrently
#3  an access token stops working when its device session ends
A2  an asset's thumbnail must be its own file
#1  an address that keeps failing is refused, a correct password included
"""
import asyncio
import time

import pyotp
import pytest
from sqlalchemy import select

from app.models.user import UserBackupCode

from tests.unit.test_auth_hardening import (  # noqa: F401  (fixtures)
    PASSWORD,
    RECOVERY,
    _client,
    _login,
    _make_user,
    _user,
    client,
    limiter,
    sessionmaker,
)

pytestmark = pytest.mark.unit


def _previous_code(secret: str) -> str:
    return pyotp.TOTP(secret).at(time.time() - 30)


async def _bearer(client, sessionmaker, *, totp=False):
    secret = await _make_user(sessionmaker, totp=totp)
    r = await _login(client, code=_previous_code(secret) if totp else None)
    assert r.status_code == 200, r.text
    return secret, {"Authorization": f"Bearer {r.json()['access_token']}"}


# ── #2: enrolment only, each code once ──────────────────────────────────────

async def test_totp_verify_refuses_once_2fa_is_on(client, sessionmaker):
    secret, headers = await _bearer(client, sessionmaker, totp=True)
    r = await client.post("/api/auth/totp/verify", headers=headers,
                          json={"code": pyotp.TOTP(secret).now()})
    assert r.status_code == 409
    # The recovery code issued at set-up still works: nothing was replaced.
    async with sessionmaker() as s:
        rows = (await s.scalars(select(UserBackupCode))).all()
    assert len(rows) == 1 and rows[0].used_at is None


async def test_totp_verify_still_finishes_enrolment(client, sessionmaker):
    _, headers = await _bearer(client, sessionmaker)
    r = await client.post("/api/auth/totp/enroll", headers=headers)
    assert r.status_code == 200
    secret = pyotp.parse_uri(r.json()["provisioning_uri"]).secret
    r = await client.post("/api/auth/totp/verify", headers=headers,
                          json={"code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200 and len(r.json()["backup_codes"]) == 10


async def test_a_totp_code_signs_in_once(client, sessionmaker):
    secret = await _make_user(sessionmaker, totp=True)
    code = pyotp.TOTP(secret).now()
    assert (await _login(client, code=code)).status_code == 200
    assert (await _login(client, code=code)).status_code == 401


# ── A4: a recovery code is spent once ───────────────────────────────────────

async def test_a_recovery_code_is_spent_by_exactly_one_of_two_sessions(sessionmaker):
    """Two sessions redeem the same code before either commits. The UPDATE is
    conditional on used_at IS NULL, so the second one finds nothing to spend.
    The old SELECT-then-assign let both read the code as unused."""
    import app.api.auth as auth_api

    await _make_user(sessionmaker, totp=True)
    user = await _user(sessionmaker)
    async with sessionmaker() as s1, sessionmaker() as s2:
        first = await auth_api._redeem_backup_code(s1, user, RECOVERY)
        second = asyncio.create_task(auth_api._redeem_backup_code(s2, user, RECOVERY))
        await asyncio.sleep(0.05)  # s2 now waits on s1's write lock
        await s1.commit()
        assert first is True and await second is False


async def test_two_concurrent_recovery_code_sign_ins_let_one_in(client, sessionmaker):
    await _make_user(sessionmaker, totp=True)
    results = await asyncio.gather(_login(client, code=RECOVERY), _login(client, code=RECOVERY))
    assert sorted(r.status_code for r in results) == [200, 401]


# ── A5: a refresh token rotates once ────────────────────────────────────────

async def test_two_concurrent_refreshes_rotate_once(client, sessionmaker):
    await _make_user(sessionmaker)
    r = await _login(client)
    cookie = r.cookies["paiso_refresh"]

    async def refresh():
        return await client.post("/api/auth/refresh", cookies={"paiso_refresh": cookie})

    results = await asyncio.gather(refresh(), refresh())
    assert sorted(x.status_code for x in results) == [200, 401]
    # The loser is treated as a replay: the device session is over.
    winner = next(x for x in results if x.status_code == 200)
    again = await client.post("/api/auth/refresh",
                              cookies={"paiso_refresh": winner.cookies["paiso_refresh"]})
    assert again.status_code == 401


async def test_a_single_refresh_still_rotates(client, sessionmaker):
    await _make_user(sessionmaker)
    cookie = (await _login(client)).cookies["paiso_refresh"]
    r1 = await client.post("/api/auth/refresh", cookies={"paiso_refresh": cookie})
    assert r1.status_code == 200
    r2 = await client.post("/api/auth/refresh", cookies={"paiso_refresh": r1.cookies["paiso_refresh"]})
    assert r2.status_code == 200
    # The first token, now rotated away, is a replay.
    r3 = await client.post("/api/auth/refresh", cookies={"paiso_refresh": cookie})
    assert r3.status_code == 401


# ── #3: the access token ends with its device session ───────────────────────

async def test_logout_ends_this_devices_access_token_at_once(client, sessionmaker):
    await _make_user(sessionmaker)
    a = await _login(client)
    async with _client(sessionmaker) as other:  # a second device, its own cookies
        b = await _login(other)
    head_a = {"Authorization": f"Bearer {a.json()['access_token']}"}
    head_b = {"Authorization": f"Bearer {b.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=head_a)).status_code == 200

    r = await client.post("/api/auth/logout", cookies={"paiso_refresh": a.cookies["paiso_refresh"]})
    assert r.status_code == 200
    assert (await client.get("/api/auth/me", headers=head_a)).status_code == 401
    # The other device is untouched.
    assert (await client.get("/api/auth/me", headers=head_b)).status_code == 200


async def test_a_detected_replay_ends_the_access_token(client, sessionmaker):
    await _make_user(sessionmaker)
    first = await _login(client)
    old_cookie = first.cookies["paiso_refresh"]
    rotated = await client.post("/api/auth/refresh", cookies={"paiso_refresh": old_cookie})
    head = {"Authorization": f"Bearer {rotated.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=head)).status_code == 200
    # Replaying the old cookie revokes the device session...
    assert (await client.post("/api/auth/refresh",
                              cookies={"paiso_refresh": old_cookie})).status_code == 401
    # ...and with it the access token minted by the rotation.
    assert (await client.get("/api/auth/me", headers=head)).status_code == 401


async def test_a_token_without_a_session_is_refused_and_refresh_recovers(client, sessionmaker):
    from app.core.security import create_access_token

    await _make_user(sessionmaker)
    r = await _login(client)
    user = await _user(sessionmaker)
    legacy = create_access_token(user.id, user.token_family)  # no sid, as before this check
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {legacy}"})
    assert me.status_code == 401
    fresh = await client.post("/api/auth/refresh", cookies={"paiso_refresh": r.cookies["paiso_refresh"]})
    head = {"Authorization": f"Bearer {fresh.json()['access_token']}"}
    assert (await client.get("/api/auth/me", headers=head)).status_code == 200


# ── A2: a thumbnail belongs to its asset ────────────────────────────────────

@pytest.fixture
async def two_assets(sessionmaker, monkeypatch):
    """Users A and B with one asset each; B's photo is in storage."""
    import json

    from app.core import storage
    from app.models.asset import Asset
    from app.models.user import User
    from tests.unit.test_import_integrity import MemoryStorage
    from tests.unit.session_tokens import app_token

    mem = MemoryStorage()
    monkeypatch.setattr(storage, "_storage", mem)
    async with sessionmaker() as s:
        a = User(email="a@example.com", hashed_password="x", token_family="fa")
        b = User(email="b@example.com", hashed_password="x", token_family="fb")
        s.add_all([a, b])
        await s.flush()
        asset_a = Asset(user_id=a.id, name="Car", category="vehicle", current_value=1)
        asset_b = Asset(user_id=b.id, name="Boat", category="vehicle", current_value=1)
        s.add_all([asset_a, asset_b])
        await s.flush()
        b_name = f"{b.id}_{asset_b.id}_deadbeef.png"
        asset_b.metadata_json = json.dumps({"custom_thumbnail": b_name})
        await s.commit()
        await mem.put(f"thumbnails/{b_name}", b"\x89PNG\r\n\x1a\nB-PRIVATE")
        head_a = {"Authorization": f"Bearer {await app_token(s, a.id, 'fa')}"}
    return {"mem": mem, "a_asset": asset_a.id, "b_name": b_name, "head_a": head_a}


@pytest.fixture
async def assets_client(sessionmaker, limiter):
    from fastapi import FastAPI
    import httpx

    from app.api import assets as assets_api
    from app.core.database import get_db

    app = FastAPI()
    app.include_router(assets_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test"
    ) as c:
        yield c


async def test_an_asset_cannot_point_at_another_users_photo(assets_client, two_assets, sessionmaker):
    import json

    from app.models.asset import Asset

    w = two_assets
    r = await assets_client.patch(
        f"/api/assets/{w['a_asset']}", headers=w["head_a"],
        json={"metadata_json": {"custom_thumbnail": w["b_name"], "note": "x"}},
    )
    assert r.status_code == 200, r.text
    async with sessionmaker() as s:
        meta = json.loads((await s.get(Asset, w["a_asset"])).metadata_json)
    assert "custom_thumbnail" not in meta and meta["note"] == "x"


async def test_a_foreign_name_already_stored_is_never_read_or_deleted(
    assets_client, two_assets, sessionmaker
):
    """Rows written before the fix may hold another user's name."""
    import json

    from app.models.asset import Asset

    w = two_assets
    async with sessionmaker() as s:
        asset = await s.get(Asset, w["a_asset"])
        asset.metadata_json = json.dumps({"custom_thumbnail": w["b_name"]})
        await s.commit()
    r = await assets_client.get(f"/api/assets/{w['a_asset']}/thumbnail", headers=w["head_a"])
    assert "B-PRIVATE" not in r.text and "data:image" not in r.text
    r = await assets_client.delete(f"/api/assets/{w['a_asset']}/thumbnail", headers=w["head_a"])
    assert r.status_code == 204
    assert f"thumbnails/{w['b_name']}" in w["mem"].files


# ── #1: an address that keeps failing is refused ────────────────────────────

async def test_an_address_past_the_limit_is_refused_even_with_the_right_password(
    client, sessionmaker, monkeypatch
):
    from app.core.config import settings

    monkeypatch.setattr(settings, "trusted_ip_header", "CF-Connecting-IP")
    await _make_user(sessionmaker)
    for i in range(20):
        r = await _login(client, email=f"nobody{i}@example.com",
                         headers={"CF-Connecting-IP": "203.0.113.7"})
        assert r.status_code == 401
    noisy = await _login(client, headers={"CF-Connecting-IP": "203.0.113.7"})
    assert noisy.status_code == 429
    # The owner, from their own address, signs in.
    assert (await _login(client, headers={"CF-Connecting-IP": "198.51.100.4"})).status_code == 200


async def test_an_email_past_the_limit_still_takes_the_right_password(client, sessionmaker, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "trusted_ip_header", "CF-Connecting-IP")
    await _make_user(sessionmaker)
    for i in range(12):
        await _login(client, password="wrong", headers={"CF-Connecting-IP": f"10.0.0.{i}"})
    assert (await _login(client, password="wrong",
                         headers={"CF-Connecting-IP": "10.9.9.9"})).status_code == 429
    assert (await _login(client, headers={"CF-Connecting-IP": "10.9.9.9"})).status_code == 200


async def test_failures_lapse_15_minutes_after_the_last_one(monkeypatch, limiter):
    from app.core import ratelimit

    now = [1000.0]
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: now[0])
    for _ in range(5):
        await ratelimit.record_failure("k", 900, sliding=True)
        now[0] += 600  # a failure every 10 minutes keeps the count alive
    assert await ratelimit.failure_count("k") == 5
    now[0] += 901
    assert await ratelimit.failure_count("k") == 0


# ── Argon2 runs off the event loop ──────────────────────────────────────────

async def test_password_checks_run_in_the_bounded_pool(monkeypatch):
    import threading

    from app.core import security

    seen = []
    real = security.verify_password

    def spy(plain, hashed):
        seen.append(threading.current_thread().name)
        return real(plain, hashed)

    h = security.hash_password("x-correct-1")
    monkeypatch.setattr(security, "verify_password", spy)
    assert await security.verify_password_async("x-correct-1", h) is True
    assert seen and seen[0].startswith("argon2")
    assert security._hash_pool._max_workers == 2

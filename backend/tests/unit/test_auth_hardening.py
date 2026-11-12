"""Sign-in hardening, through the real endpoints.

The limiter runs for real against a fresh in-memory store, so these tests
exercise the same counting code the app runs.
"""
import time

import httpx
import pyotp
import pytest
from types import SimpleNamespace
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.api.auth as auth_api
import app.models  # noqa: F401
from app.core import ratelimit
from app.core.config import settings
from app.core.database import Base, get_db
from app.core.security import encrypt_totp_secret, hash_backup_code, hash_password
from app.models.user import User, UserBackupCode

pytestmark = pytest.mark.unit

PASSWORD = "correct-horse-battery-9"
RECOVERY = "ABCD-EFGH-JKMN"


@pytest.fixture
def limiter(monkeypatch):
    """The rate limiter's counts, empty for each test. (Named for the store
    the counts used to live in.)"""
    counts: dict = {}
    monkeypatch.setattr(ratelimit, "_counts", counts)
    return SimpleNamespace(store=counts)


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'auth.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def _app(sessionmaker) -> FastAPI:
    app = FastAPI()
    app.include_router(auth_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    return app


def _client(sessionmaker) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=_app(sessionmaker)), base_url="https://app.test"
    )


@pytest.fixture
async def client(sessionmaker, limiter):
    async with _client(sessionmaker) as c:
        yield c


async def _make_user(sessionmaker, email="ada@example.com", *, totp=False) -> str | None:
    """Returns the TOTP secret when `totp` is on."""
    secret = pyotp.random_base32() if totp else None
    async with sessionmaker() as s:
        user = User(
            email=email, hashed_password=hash_password(PASSWORD), token_family="fam0",
            totp_enabled=totp, totp_secret=encrypt_totp_secret(secret) if secret else None,
        )
        s.add(user)
        await s.flush()
        if totp:
            s.add(UserBackupCode(user_id=user.id, code_hash=hash_backup_code(RECOVERY)))
        await s.commit()
    return secret


async def _user(sessionmaker, email="ada@example.com") -> User:
    async with sessionmaker() as s:
        return await s.scalar(select(User).where(User.email == email))


async def _unlock(sessionmaker, email="ada@example.com") -> None:
    """Clear the lockout ladder's delay so a test can make its next attempt at
    once. The failure counters under test are untouched."""
    async with sessionmaker() as s:
        user = await s.scalar(select(User).where(User.email == email))
        user.locked_until = None
        await s.commit()


async def _login(client, email="ada@example.com", password=PASSWORD, code=None, **kw):
    body = {"email": email, "password": password}
    if code is not None:
        body["totp_code"] = code
    return await client.post("/api/auth/login", json=body, **kw)


# ── Second factor ─────────────────────────────────────────────────────

async def test_a_wrong_code_counts_as_a_failed_sign_in(client, sessionmaker, limiter):
    await _make_user(sessionmaker, totp=True)

    r = await _login(client, code="000000")
    assert r.status_code == 401 and r.json()["detail"] == "Invalid 2FA code"

    # Counted against the per-account second-factor limiter (the old DB lockout
    # ladder was removed — correct passwords must never be blocked).
    assert any("login_code" in k for k in limiter.store)


async def test_asking_for_the_code_is_not_a_failure(client, sessionmaker, limiter):
    """The form sends the password alone first; that step must cost nothing,
    or every 2FA sign-in would begin with a strike and a two-second lock."""
    secret = await _make_user(sessionmaker, totp=True)

    r = await _login(client)
    assert r.status_code == 401 and r.json()["detail"] == "Invalid 2FA code"
    user = await _user(sessionmaker)
    assert (user.failed_logins or 0) == 0 and user.locked_until is None
    assert limiter.store == {}

    r = await _login(client, code=pyotp.TOTP(secret).now())
    assert r.status_code == 200


async def test_wrong_codes_run_out(client, sessionmaker):
    secret = await _make_user(sessionmaker, totp=True)
    for _ in range(5):
        assert (await _login(client, code="000000")).status_code == 401
        await _unlock(sessionmaker)

    # The right code no longer helps until the window passes.
    r = await _login(client, code=pyotp.TOTP(secret).now())
    assert r.status_code == 429
    # ...and neither does a recovery code, which must not be spent by the try.
    r = await _login(client, code=RECOVERY)
    assert r.status_code == 429
    async with sessionmaker() as s:
        assert (await s.scalar(select(UserBackupCode))).used_at is None


async def test_success_clears_the_counter(client, sessionmaker):
    secret = await _make_user(sessionmaker, totp=True)
    await _login(client, code="000000")
    await _unlock(sessionmaker)
    assert (await _login(client, code=pyotp.TOTP(secret).now())).status_code == 200
    assert (await _user(sessionmaker)).failed_logins == 0


# ── Sign-in limits ─────────────────────────────────────────────────────

async def test_wrong_guesses_per_email_run_out(client, sessionmaker):
    """Without a challenge configured, wrong guesses against one email are
    still capped (the fallback). Only *wrong* attempts are refused."""
    await _make_user(sessionmaker)
    for _ in range(10):
        assert (await _login(client, password="wrong")).status_code == 401
    # The 11th wrong attempt is over the per-email ceiling.
    assert (await _login(client, password="wrong")).status_code == 429


async def test_a_correct_password_is_never_blocked_by_failures(client, sessionmaker):
    """The core rule: other people's failed guesses — even enough to trip
    the limit — must never stop the real owner signing in with the right
    password. The old behaviour answered 429 here and locked them out."""
    await _make_user(sessionmaker)
    for _ in range(15):
        # Wrong guesses — 401 at first, then 429 once over the ceiling.
        assert (await _login(client, password="wrong")).status_code in (401, 429)
    # The correct password is accepted even though the counters are maxed out.
    assert (await _login(client)).status_code == 200


async def test_failed_sign_ins_per_address_run_out(client, sessionmaker):
    await _make_user(sessionmaker)
    for i in range(20):
        r = await _login(client, email=f"nobody{i}@example.com")
        assert r.status_code == 401
    # Over the ceiling every attempt from the address is refused, a correct
    # password included: accepting one let a guesser that ignored the 429
    # keep going until it found one.
    assert (await _login(client, email="nobody99@example.com")).status_code == 429
    assert (await _login(client)).status_code == 429


async def test_successful_sign_ins_are_never_limited(client, sessionmaker, limiter):
    await _make_user(sessionmaker)
    for _ in range(30):
        assert (await _login(client)).status_code == 200
    assert limiter.store == {}


async def test_the_trusted_header_separates_visitors(client, sessionmaker, monkeypatch):
    await _make_user(sessionmaker)
    monkeypatch.setattr(settings, "trusted_ip_header", "CF-Connecting-IP")
    for i in range(20):
        r = await _login(client, email=f"nobody{i}@example.com",
                         headers={"CF-Connecting-IP": "203.0.113.7"})
        assert r.status_code == 401
    # Over the ceiling, a further wrong attempt from that address is refused…
    assert (await _login(client, password="wrong",
                         headers={"CF-Connecting-IP": "203.0.113.7"})).status_code == 429
    # …while a different visitor's address is its own bucket, unaffected.
    assert (await _login(client, password="wrong",
                         headers={"CF-Connecting-IP": "198.51.100.4"})).status_code == 401
    # …and the real owner signs in from their own address, while the noisy
    # address itself stays refused.
    assert (await _login(client, headers={"CF-Connecting-IP": "198.51.100.4"})).status_code == 200
    assert (await _login(client, headers={"CF-Connecting-IP": "203.0.113.7"})).status_code == 429


async def test_the_header_is_ignored_unless_configured(client, sessionmaker, limiter):
    """With no edge overwriting it, the header is whatever the client says, so
    every attempt shares one address bucket regardless of the header."""
    await _make_user(sessionmaker)
    for i in range(20):
        await _login(client, email=f"nobody{i}@example.com",
                     headers={"CF-Connecting-IP": f"10.9.9.{i}"})
    # A further wrong attempt is over the ceiling whatever header it claims.
    assert (await _login(client, password="wrong",
                         headers={"CF-Connecting-IP": "10.1.1.1"})).status_code == 429


# ── Turning 2FA off, and new recovery codes ─────────────────────────────────

async def _signed_in(client, sessionmaker, **kw):
    secret = await _make_user(sessionmaker, totp=True, **kw)
    # The previous 30-second step's code, still accepted, so the current one
    # stays unused for the test's next step: each code now works once.
    r = await _login(client, code=pyotp.TOTP(secret).at(time.time() - 30))
    return secret, {"Authorization": f"Bearer {r.json()['access_token']}"}


async def test_a_session_alone_cannot_turn_2fa_off(client, sessionmaker):
    secret, headers = await _signed_in(client, sessionmaker)
    for body in (None, {"password": PASSWORD}, {"code": pyotp.TOTP(secret).now()},
                 {"password": "wrong", "code": pyotp.TOTP(secret).now()}):
        r = await client.post("/api/auth/totp/disable", json=body, headers=headers)
        assert r.status_code == 400, body
    assert (await _user(sessionmaker)).totp_enabled is True


async def test_turning_2fa_off_with_password_and_code(client, sessionmaker):
    secret, headers = await _signed_in(client, sessionmaker)
    r = await client.post("/api/auth/totp/disable", headers=headers,
                          json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200
    user = await _user(sessionmaker)
    assert user.totp_enabled is False and user.totp_secret is None


async def test_reauth_attempts_run_out(client, sessionmaker):
    secret, headers = await _signed_in(client, sessionmaker)
    for _ in range(5):
        r = await client.post("/api/auth/totp/disable", headers=headers,
                              json={"password": "wrong", "code": "000000"})
        assert r.status_code == 400
    r = await client.post("/api/auth/totp/disable", headers=headers,
                          json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 429


async def test_new_recovery_codes_need_reauth(client, sessionmaker):
    secret, headers = await _signed_in(client, sessionmaker)
    r = await client.post("/api/auth/totp/backup-codes", headers=headers)
    assert r.status_code == 400
    r = await client.post("/api/auth/totp/backup-codes", headers=headers,
                          json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200 and len(r.json()["backup_codes"]) == 10


# ── Sessions ─────────────────────────────────────────────────────────────────

async def test_changing_the_password_keeps_this_device_signed_in(client, sessionmaker):
    """It used to hand back a refresh cookie with no session behind it, so the
    next refresh failed and the person was signed out within the hour."""
    await _make_user(sessionmaker)
    token = (await _login(client)).json()["access_token"]
    r = await client.post(
        "/api/auth/password", headers={"Authorization": f"Bearer {token}"},
        json={"current_password": PASSWORD, "new_password": "another-Horse-battery-7"},
    )
    assert r.status_code == 200, r.text

    r = await client.post("/api/auth/refresh")
    assert r.status_code == 200, r.text
    me = await client.get("/api/auth/sessions",
                          headers={"Authorization": f"Bearer {r.json()['access_token']}"})
    assert me.json()["active"] == 1


async def test_sign_out_other_devices(sessionmaker, limiter):
    await _make_user(sessionmaker)
    async with _client(sessionmaker) as here, _client(sessionmaker) as there:
        mine = {"Authorization": f"Bearer {(await _login(here)).json()['access_token']}"}
        theirs = {"Authorization": f"Bearer {(await _login(there)).json()['access_token']}"}
        listed = (await here.get("/api/auth/sessions", headers=mine)).json()
        assert listed["active"] == 2
        # Each device is listed, and this one is marked as the current one.
        assert len(listed["sessions"]) == 2
        assert sum(s["current"] for s in listed["sessions"]) == 1

        r = await here.post("/api/auth/sessions/revoke-others", headers=mine)
        assert r.status_code == 200
        mine = {"Authorization": f"Bearer {r.json()['access_token']}"}

        # The other device is out at once, and cannot refresh its way back.
        assert (await there.get("/api/auth/sessions", headers=theirs)).status_code == 401
        assert (await there.post("/api/auth/refresh")).status_code == 401
        # This one carries on.
        assert (await here.get("/api/auth/sessions", headers=mine)).json()["active"] == 1
        assert (await here.post("/api/auth/refresh")).status_code == 200


async def test_signing_in_again_in_the_same_browser_replaces_its_session(sessionmaker, limiter):
    """A second sign-in overwrites this browser's refresh cookie, so the row
    the old cookie named must end, not linger as "another device"."""
    await _make_user(sessionmaker)
    async with _client(sessionmaker) as here:
        await _login(here)
        token = (await _login(here)).json()["access_token"]
        listed = (await here.get(
            "/api/auth/sessions", headers={"Authorization": f"Bearer {token}"}
        )).json()
        assert listed["active"] == 1
        assert listed["sessions"][0]["current"] is True

    from app.models.auth_session import RefreshToken
    async with sessionmaker() as s:
        # The replaced row is gone, not kept as revoked.
        assert len((await s.scalars(select(RefreshToken))).all()) == 1


async def test_each_device_is_named_by_its_browser(sessionmaker, limiter):
    await _make_user(sessionmaker)
    mac = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
    phone = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
             "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
    async with _client(sessionmaker) as here, _client(sessionmaker) as there:
        token = (await _login(here, headers={"User-Agent": mac})).json()["access_token"]
        await _login(there, headers={"User-Agent": phone})
        listed = (await here.get(
            "/api/auth/sessions", headers={"Authorization": f"Bearer {token}"}
        )).json()["sessions"]
    # This device comes first.
    assert [(s["current"], s["device"]) for s in listed] == [
        (True, "Chrome on macOS"), (False, "Safari on iPhone"),
    ]


def test_device_label():
    assert auth_api.device_label(None) is None
    assert auth_api.device_label("curl/8.4.0") is None
    assert auth_api.device_label(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0"
    ) == "Edge on Windows"
    assert auth_api.device_label(
        "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"
    ) == "Firefox on Linux"


async def test_ending_every_session_revokes_the_rows_too(sessionmaker, limiter):
    """Changing token_family alone left each row listed until it expired."""
    await _make_user(sessionmaker)
    async with _client(sessionmaker) as here:
        await _login(here)
    from app.models.auth_session import RefreshToken
    async with sessionmaker() as s:
        user = await s.scalar(select(User).where(User.email == "ada@example.com"))
        await auth_api.end_all_sessions(s, user)
        await s.commit()
        rows = (await s.scalars(select(RefreshToken))).all()
        assert rows and all(r.revoked_at is not None for r in rows)


async def test_sign_in_is_case_insensitive(client, sessionmaker):
    """The address is stored and compared in one canonical (lower) form, so a
    capitalised spelling signs in to the same account."""
    await _make_user(sessionmaker, email="ada@example.com")
    assert (await _login(client, email="Ada@Example.com")).status_code == 200
    assert (await _login(client, email="ADA@EXAMPLE.COM")).status_code == 200


async def test_the_first_sign_up_creates_the_account(client):
    r = await client.post("/api/auth/register",
                          json={"email": "ada@example.com", "password": PASSWORD})
    assert r.status_code == 201
    assert r.json()["access_token"]


async def test_sign_up_closes_once_the_account_exists(client, sessionmaker):
    """One account per install (Q12): any second sign-up is refused with the
    same answer, whatever the address, so it says nothing about the one on
    file."""
    await _make_user(sessionmaker, email="ada@example.com")
    for email in ("ADA@example.com", "someone-else@example.com"):
        r = await client.post("/api/auth/register",
                              json={"email": email, "password": "another-good-pass-7"})
        assert r.status_code == 403
        assert r.json()["detail"] == auth_api.SIGNUP_CLOSED


# ── Destructive actions need re-authentication ───────────────────────

async def test_a_session_alone_cannot_delete_account(client, sessionmaker):
    """A session token must not be enough to delete the account."""
    secret, headers = await _signed_in(client, sessionmaker)  # 2FA account
    for body in (None, {"password": PASSWORD}, {"code": pyotp.TOTP(secret).now()},
                 {"password": "wrong", "code": pyotp.TOTP(secret).now()}):
        r = await client.request("DELETE", "/api/auth/account", json=body, headers=headers)
        assert r.status_code == 400, body
    assert await _user(sessionmaker) is not None

    # The right password AND a live code goes through.
    r = await client.request("DELETE", "/api/auth/account", headers=headers,
                             json={"password": PASSWORD, "code": pyotp.TOTP(secret).now()})
    assert r.status_code == 200
    assert await _user(sessionmaker) is None


async def test_delete_on_a_password_only_account_needs_the_password(client, sessionmaker):
    await _make_user(sessionmaker)
    headers = {"Authorization": f"Bearer {(await _login(client)).json()['access_token']}"}
    assert (await client.request("DELETE", "/api/auth/account", headers=headers,
                                 json={"password": "wrong"})).status_code == 400
    assert await _user(sessionmaker) is not None
    assert (await client.request("DELETE", "/api/auth/account", headers=headers,
                                 json={"password": PASSWORD})).status_code == 200
    assert await _user(sessionmaker) is None


async def test_reset_data_needs_reauth(client, sessionmaker):
    await _make_user(sessionmaker)
    headers = {"Authorization": f"Bearer {(await _login(client)).json()['access_token']}"}
    assert (await client.request("DELETE", "/api/auth/data", headers=headers,
                                 json=None)).status_code == 400
    assert (await client.request("DELETE", "/api/auth/data", headers=headers,
                                 json={"password": PASSWORD})).status_code == 200


# ── No account enumeration ─────────────────────────────────────────────

async def test_sign_in_spends_a_password_check_when_there_is_no_account(
    client, sessionmaker, monkeypatch
):
    """An unknown address and an account with no password hash cost the
    same Argon2 work as a wrong password, and get the same answer."""
    burned: list[str] = []

    async def burn(plain):
        burned.append(plain)

    monkeypatch.setattr(auth_api, "burn_password_check_async", burn)
    async with sessionmaker() as s:
        s.add(User(email="nohash@example.com", hashed_password=None, token_family="f"))
        await s.commit()
    await _make_user(sessionmaker)

    answers = [
        await _login(client, email="nobody@example.com"),
        await _login(client, email="nohash@example.com"),
        await _login(client, password="wrong-password-1"),
    ]
    assert [r.status_code for r in answers] == [401, 401, 401]
    assert {r.json()["detail"] for r in answers} == {"Invalid credentials"}
    assert len(burned) == 2  # the two with no hash; the wrong password ran the real one


def test_the_burn_runs_a_real_argon2_check():
    from app.core import security

    security.burn_password_check("anything")
    assert security._dummy_hash and security._dummy_hash.startswith("$argon2")

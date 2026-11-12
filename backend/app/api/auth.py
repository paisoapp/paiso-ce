import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import structlog
from fastapi import APIRouter, Cookie, Depends, File, HTTPException, Request, Response, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, inspect as sa_inspect, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.validation import AccountHolderBirthDate, NormalizedEmail, USPhone, password_problem
from app.core.config import settings
from app.core.database import get_db
from app.core.ratelimit import (
    first_use,
    check_failures,
    check_rate,
    client_ip,
    failure_count,
    record_failure,
    reset_failures,
)
from app.core.uploads import AVATAR_MAX_BYTES, UPLOAD_RATE, read_capped, sniff_image
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_token,
    BACKUP_CODE_COUNT,
    burn_password_check_async,
    encrypt_totp_secret,
    generate_backup_code,
    generate_totp_secret,
    hash_backup_code,
    normalize_backup_code,
    hash_password_async,
    totp_provisioning_uri,
    verify_password_async,
    verify_totp,
)
from app.models.auth_session import RefreshToken
from app.models.settings import UserSettings
from app.models.user import User
from app.modules.accounts.seed_categories import seed_default_categories

# Ordered SQL statements to wipe all rows belonging to a user.
# Child tables are deleted before parents via subqueries so no FK
# violation can occur. Tables without user_id use IN-subqueries to
# scope the delete to the user. Shared reference tables (security,
# institution) are intentionally omitted.
_WIPE_SQL = [
    # ── Nullify self-referential and cross-table FKs first ───────────────────
    # category.parent_id → category (self-ref, bulk delete fails row-by-row with FK=ON)
    "UPDATE category SET parent_id = NULL WHERE user_id = :uid",
    # account.linked_asset_id → asset (cross-ref; account must survive until after asset is gone)
    "UPDATE account SET linked_asset_id = NULL WHERE user_id = :uid",

    # ── asset subtree ────────────────────────────────────────────────────────
    "DELETE FROM payment_schedule WHERE loan_id IN (SELECT id FROM loan WHERE asset_id IN (SELECT id FROM asset WHERE user_id = :uid))",
    "DELETE FROM loan WHERE asset_id IN (SELECT id FROM asset WHERE user_id = :uid)",
    "DELETE FROM asset WHERE user_id = :uid",

    # ── account subtree ──────────────────────────────────────────────────────
    "DELETE FROM trade WHERE holding_id IN (SELECT id FROM holding WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid))",
    "DELETE FROM holding WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)",
    "DELETE FROM transaction_attachment WHERE user_id = :uid",
    # Must precede the transaction delete: SQLite runs with PRAGMA
    # foreign_keys=ON, so a surviving FK raises rather than cascading.
    "DELETE FROM transfer_link WHERE user_id = :uid",
    'DELETE FROM "transaction" WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)',
    "DELETE FROM csv_mapping WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)",
    "DELETE FROM account_liability WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)",
    "DELETE FROM account_balance_snapshot WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)",
    "DELETE FROM account WHERE user_id = :uid",

    # ── categories ───────────────────────────────────────────────────────────
    "DELETE FROM category_rule WHERE user_id = :uid",
    "DELETE FROM category WHERE user_id = :uid",

    # ── standalone user tables ───────────────────────────────────────────────
    "DELETE FROM net_worth_snapshot WHERE user_id = :uid",
    "DELETE FROM user_settings WHERE user_id = :uid",
]


log = structlog.get_logger()


def _require_password_policy(password: str, email: str | None = None) -> None:
    """One rule set for every path that sets a password (see core.validation).

    Sign-up and change-password both call it, so an account already signed
    in cannot be given a weaker password than a new one.
    """
    problem = password_problem(password, email)
    if problem:
        raise HTTPException(status_code=400, detail=problem)


async def delete_user_completely(db: AsyncSession, user: User) -> None:
    """The one way a user is deleted: the data first, then the user."""
    await _wipe_user_data(user.id, db)
    await db.delete(user)


async def _wipe_user_data(
    user_id: int, db: AsyncSession
) -> None:
    """Delete every row belonging to user_id across all data tables."""
    conn = await db.connection()
    existing = await conn.run_sync(lambda c: set(sa_inspect(c).get_table_names()))

    for stmt in _WIPE_SQL:
        # Extract the table name (works for both DELETE FROM and UPDATE <table>)
        keyword = "UPDATE " if stmt.upper().startswith("UPDATE") else "FROM "
        table = stmt.split(keyword)[1].split()[0].strip('"').lower()
        if table in existing:
            await db.execute(text(stmt), {"uid": user_id})

    await db.flush()
    from app.core.storage import get_storage
    storage = get_storage()
    await storage.delete_prefix(f"attachments/{user_id}/")
    # CSV statements staged by the import wizard and never committed.
    from app.modules.accounts.csv_parser import upload_prefix
    await storage.delete_prefix(upload_prefix(user_id))

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Failed sign-ins allowed per window before /login answers 429. Per
# address catches one host trying many accounts; per email catches many hosts
# trying one account, which no edge rule can see. Only failures count, so
# people who sign in often, or share an office address, are never limited.
# Each count lasts 15 minutes after the most recent failure (a sliding
# window), so steady guessing keeps the limits in force and a quiet key clears.
_LOGIN_WINDOW_SECS = 900
_LOGIN_MAX_FAILS_PER_IP = 20
_LOGIN_MAX_FAILS_PER_EMAIL = 10
# - An address past _LOGIN_MAX_FAILS_PER_IP gets 429 for every attempt, a
#   correct password included, until its count lapses. Accepting a correct
#   password there let a guesser that ignored the 429 keep going until it
#   found one. The owner signs in from their own address.
# - An email past _LOGIN_MAX_FAILS_PER_EMAIL has only *wrong* attempts
#   refused, so guessing at an account from many addresses cannot lock its
#   owner out.
# Wrong second-factor codes per account. Reaching this step takes the
# right password, so a stranger cannot use it to lock someone out.
_CODE_WINDOW_SECS = 900
_CODE_MAX_FAILS = 5


class _CodeNeeded(HTTPException):
    """The password was right and no code was sent. The sign-in form sends
    the password alone first and shows the code field on this answer, so it
    is a normal step of every 2FA sign-in, not a failed attempt."""

    def __init__(self) -> None:
        super().__init__(status_code=401, detail="Invalid 2FA code")



class RegisterIn(BaseModel):
    email: NormalizedEmail
    password: str


class LoginIn(BaseModel):
    email: NormalizedEmail
    password: str
    totp_code: str | None = None


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


class ReauthIn(BaseModel):
    password: str | None = None
    code: str | None = None


class ProfileUpdateIn(BaseModel):
    first_name: str | None = Field(None, max_length=100)
    last_name: str | None = Field(None, max_length=100)
    # Accuracy, not just syntax: no 0001-01-01, no future dates, and
    # the account holder is an adult. Phone is validated for the US and
    # stored as E.164.
    dob: AccountHolderBirthDate | None = None
    phone: USPhone | None = None


def _profile_out(user: User) -> dict:
    return {
        "email": user.email,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "dob": user.dob.isoformat() if user.dob else None,
        "phone": user.phone,
        "avatar": user.avatar,
        "totp_enabled": user.totp_enabled,
        # A forced change needs the current password; an account without a
        # hash could not complete the form. (The gate in deps.py agrees.)
        "must_change_password": user.must_change_password and bool(user.hashed_password),
        "mfa_setup_required": user.mfa_required and not user.totp_enabled,
        "has_password": bool(user.hashed_password),
    }


# Avatar is stored inline as a base64 data-URI on the user row. Cap the raw
# upload at 1 MB; the frontend downscales before upload so real payloads are tiny.
_MAX_AVATAR_BYTES = AVATAR_MAX_BYTES
_ALLOWED_AVATAR_TYPES = {"image/png", "image/jpeg", "image/webp", "image/gif"}


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


#: How long a TOTP code stays acceptable: pyotp's valid_window=1 takes the
#: previous, current and next 30-second step.
_TOTP_REUSE_SECS = 90


async def _totp_ok(user: User, code: str) -> bool:
    """A correct authenticator code that has not been used yet.

    verify_totp alone accepts the same code for its whole 90-second window, so
    a code seen over someone's shoulder worked a second time. The first use is
    remembered for that long, and a repeat reads as a wrong code."""
    code = (code or "").strip()
    if not user.totp_secret or not verify_totp(user.totp_secret, code):
        return False
    return await first_use(f"totp_used:{user.id}:{code}", _TOTP_REUSE_SECS)


async def _redeem_backup_code(db: AsyncSession, user: User, supplied: str) -> bool:
    """Spend one unused recovery code. True when it matched.

    Compared by hash lookup rather than by iterating and comparing in Python,
    so a wrong code costs the same as a right one.
    """
    from app.models.user import UserBackupCode

    candidate = hash_backup_code(supplied)
    if not normalize_backup_code(supplied):
        return False
    # One conditional UPDATE, so of two requests racing with the same code
    # exactly one sees a row change. A SELECT and then a write let
    # both read the code as unused and both sign in.
    spent = await db.scalar(
        update(UserBackupCode)
        .where(
            UserBackupCode.user_id == user.id,
            UserBackupCode.code_hash == candidate,
            UserBackupCode.used_at.is_(None),
        )
        .values(used_at=datetime.now(timezone.utc))
        .returning(UserBackupCode.id)
    )
    return spent is not None


async def _issue_backup_codes(db: AsyncSession, user: User) -> list[str]:
    """Replace this user's codes with a fresh set, returning the plaintext.

    Regenerating invalidates every previous code — a printed list that may have
    been photographed should stop working the moment a new one is issued. The
    plaintext is returned exactly once and never stored.
    """
    from app.models.user import UserBackupCode

    for existing in (await db.scalars(
        select(UserBackupCode).where(UserBackupCode.user_id == user.id)
    )).all():
        await db.delete(existing)

    codes = [generate_backup_code() for _ in range(BACKUP_CODE_COUNT)]
    for code in codes:
        db.add(UserBackupCode(user_id=user.id, code_hash=hash_backup_code(code)))
    return codes


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite strips tzinfo on storage; normalize to aware-UTC for compares."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def _issue_session(
    user: User, response: Response, db: AsyncSession, request: Request | None = None
) -> str:
    """Create a per-device refresh session, set the cookie, return an access
    token. One row per device; redemption rotates the row's token hash.

    When the request already carries a refresh cookie, this browser is
    replacing its session (signing in again, or as someone else), so the row
    that cookie names is ended: nothing can redeem it once the cookie is
    overwritten, and left alone it would sit in the device list as "another
    device" until it expired. Rows that can no longer be redeemed are
    deleted at the same time, so the table does not grow with every sign-in.
    """
    now = datetime.now(timezone.utc)
    old_cookie = request.cookies.get("paiso_refresh") if request is not None else None
    if old_cookie:
        try:
            old_family = decode_token(old_cookie).get("family")
        except Exception:
            old_family = None
        if old_family:
            await db.execute(
                update(RefreshToken)
                .where(RefreshToken.family == old_family, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=now)
            )
    await db.execute(
        delete(RefreshToken).where(
            RefreshToken.user_id == user.id,
            (RefreshToken.revoked_at.is_not(None)) | (RefreshToken.expires_at < now),
        )
    )
    device_family = secrets.token_hex(16)
    refresh_jwt = create_refresh_token(user.id, device_family, epoch=user.token_family)
    user_agent = request.headers.get("user-agent") if request is not None else None
    db.add(RefreshToken(
        user_id=user.id,
        family=device_family,
        token_hash=_sha256(refresh_jwt),
        expires_at=now + timedelta(days=settings.jwt_refresh_expire_days),
        user_agent=(user_agent or "")[:255] or None,
    ))
    await db.commit()
    _set_refresh_cookie(response, refresh_jwt, request)
    return create_access_token(user.id, user.token_family, sid=device_family)


def device_label(user_agent: str | None) -> str | None:
    """A short "Browser on OS" label from a User-Agent, or None when it says
    nothing recognisable. Order matters: Edge and Opera also claim Chrome,
    and Chrome also claims Safari."""
    ua = user_agent or ""
    browser = next((name for token, name in (
        ("Edg/", "Edge"), ("OPR/", "Opera"), ("Firefox/", "Firefox"), ("FxiOS/", "Firefox"),
        ("CriOS/", "Chrome"), ("Chrome/", "Chrome"), ("Safari/", "Safari"),
    ) if token in ua), None)
    system = next((name for token, name in (
        ("iPhone", "iPhone"), ("iPad", "iPad"), ("Android", "Android"),
        ("Mac OS X", "macOS"), ("Windows", "Windows"), ("CrOS", "ChromeOS"), ("Linux", "Linux"),
    ) if token in ua), None)
    if browser and system:
        return f"{browser} on {system}"
    return browser or system


async def end_all_sessions(db: AsyncSession, user: User) -> None:
    """Sign every device out, without committing.

    Rotating token_family kills live access tokens and refresh cookies at
    once; the refresh rows are revoked as well so the device list stays
    truthful. Changing token_family alone left every row listed as a signed-in
    device until it expired.
    """
    user.token_family = secrets.token_hex(16)
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )


async def _rotate_sessions(
    user: User, response: Response, db: AsyncSession, request: Request | None = None
) -> str:
    """Sign every device out, then start a fresh session for this one."""
    await end_all_sessions(db, user)
    return await _issue_session(user, response, db, request)


async def _require_reauth(db: AsyncSession, user: User, body: ReauthIn) -> None:
    """Changing the second factor takes more than a session.

    An access token lives in the browser, so a stolen one must not be enough
    to strip 2FA off an account or mint new recovery codes. The password is
    asked for when the account has one; a current authenticator or recovery
    code is always required.
    """
    key = f"reauth:{user.id}"
    await check_failures(key, _CODE_MAX_FAILS)
    code = (body.code or "").strip()
    ok = not user.hashed_password or await verify_password_async(body.password or "", user.hashed_password)
    ok = ok and bool(code) and (
        await _totp_ok(user, code) or await _redeem_backup_code(db, user, code)
    )
    if not ok:
        await record_failure(key, _CODE_WINDOW_SECS)
        raise HTTPException(status_code=400, detail="Password or code incorrect")


async def _require_reauth_destructive(db: AsyncSession, user: User, body: ReauthIn) -> None:
    """Re-authentication gate for irreversible actions (delete account, reset
    all data). A session token alone must not be enough to wipe an account —
    a stolen or XSS-exfiltrated access token would otherwise destroy
    everything, and 2FA (checked only at sign-in) would not help.

    Unlike :func:`_require_reauth` (2FA changes, where a code always exists),
    this adapts to what the account has:

    * password account → the current password, plus a live TOTP/recovery code
      when 2FA is on;
    * no password hash, 2FA on → a live TOTP/recovery code;
    * no password hash and no 2FA → refuse, since there is no secret to
      check.
    """
    key = f"reauth_destructive:{user.id}"
    await check_failures(key, _CODE_MAX_FAILS)

    has_pw = bool(user.hashed_password)
    if not has_pw and not user.totp_enabled:
        raise HTTPException(
            status_code=400,
            detail="set_password_required",
        )

    ok = True
    if has_pw:
        ok = await verify_password_async(body.password or "", user.hashed_password)
    if user.totp_enabled:
        code = (body.code or "").strip()
        ok = ok and bool(code) and (
            await _totp_ok(user, code) or await _redeem_backup_code(db, user, code)
        )
    if not ok:
        await record_failure(key, _CODE_WINDOW_SECS)
        raise HTTPException(status_code=400, detail="Password or code incorrect")


async def _create_user(
    email: str,
    password: str | None,
    db: AsyncSession,
    *,
    verified: bool,
    first_name: str | None = None,
    last_name: str | None = None,
    hashed_password: str | None = None,
) -> User:
    """`hashed_password` is a password hashed earlier; without one the
    plain `password` is hashed here."""
    if hashed_password is None and password is not None:
        hashed_password = await hash_password_async(password)
    user = User(
        email=email,
        hashed_password=hashed_password,
        token_family=secrets.token_hex(16),
        email_verified_at=datetime.now(timezone.utc) if verified else None,
        first_name=first_name,
        last_name=last_name,
    )
    db.add(user)
    await db.flush()
    db.add(UserSettings(user_id=user.id))
    await db.flush()
    await seed_default_categories(user.id, db)
    await db.commit()
    await db.refresh(user)
    return user


#: Why sign-up refuses once the install has its account.
SIGNUP_CLOSED = "This Paiso already has its account. Sign in instead."


async def signup_closed(db: AsyncSession) -> bool:
    """True once the install's one account exists."""
    return await db.scalar(select(User.id).limit(1)) is not None


@router.post("/register", response_model=TokenOut, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)
):
    """Sign-up: creates the account at once. The self-hosted edition sends no
    email, so nothing checks the address and the account starts unverified.

    One account per install (Q12): once it exists, sign-up is closed for good.
    Starting over means deleting the data volume."""
    await check_rate(f"register_ip:{client_ip(request)}", max_calls=30, window_secs=3600)
    if await signup_closed(db):
        raise HTTPException(status_code=403, detail=SIGNUP_CLOSED)
    # The closed check comes first, so a second sign-up never learns whether
    # its address is the one on file.
    _require_password_policy(body.password, body.email)

    user = await _create_user(body.email, body.password, db, verified=False)
    access = await _issue_session(user, response, db, request)
    return TokenOut(access_token=access)


@router.post("/login", response_model=TokenOut)
async def login(
    body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(get_db)
):
    ip = client_ip(request)
    ip_key = f"login_ip:{ip}"
    email_key = f"login_email:{body.email.lower()}"

    ip_fails = await failure_count(ip_key)
    email_fails = await failure_count(email_key)
    if ip_fails >= _LOGIN_MAX_FAILS_PER_IP:
        # This address has failed too often: refuse every attempt from it,
        # before any password work, until its count lapses.
        raise HTTPException(status_code=429, detail="Too many attempts. Please try again later.")

    user = await db.scalar(select(User).where(func.lower(User.email) == body.email.lower()))
    try:
        await _verify_login(user, body, db)
    except _CodeNeeded:
        raise
    except HTTPException as e:
        if e.status_code == 401:
            await record_failure(ip_key, _LOGIN_WINDOW_SECS, sliding=True)
            await record_failure(email_key, _LOGIN_WINDOW_SECS, sliding=True)
            # A wrong attempt past either ceiling is answered 429. For the
            # email ceiling only wrong attempts reach here, so it cannot lock
            # the real owner out.
            if (
                ip_fails + 1 > _LOGIN_MAX_FAILS_PER_IP
                or email_fails + 1 > _LOGIN_MAX_FAILS_PER_EMAIL
            ):
                raise HTTPException(
                    status_code=429,
                    detail="Too many attempts. Please try again later.",
                )
        raise

    # Clean slate on success, so earlier failures stop counting.
    await reset_failures(ip_key, email_key)
    access = await _issue_session(user, response, db, request)
    return TokenOut(access_token=access)


async def _verify_login(user: User | None, body: LoginIn, db: AsyncSession) -> None:
    """Shared credential check for both login flows: password, then TOTP.
    Raises on failure.

    There is deliberately no per-account lockout here any more. Blocking before
    the password was checked meant other people's failed guesses could refuse a
    correct password and keep the real owner out. Throttling now lives in
    the caller: a failure counter that only ever counts *failures*. A correct
    password is always accepted."""
    # No account, and an account with no password hash, fail exactly like a
    # wrong password: the same 401 after the same Argon2 work, so neither the
    # answer nor its timing tells which addresses have an account.
    if not user or not user.hashed_password:
        await burn_password_check_async(body.password)
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not await verify_password_async(body.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    if user.totp_enabled:
        if not (body.totp_code or "").strip():
            raise _CodeNeeded()
        # A wrong code used to raise without touching any counter, which left
        # whoever held the password free to guess the six digits, and the
        # recovery codes, for as long as they liked. Reaching this step
        # takes the right password, so this counter can't be used to lock a
        # stranger's account.
        code_key = f"login_code:{user.id}"
        await check_failures(code_key, _CODE_MAX_FAILS)
        try:
            await _check_second_factor(db, user, body.totp_code)
        except HTTPException:
            await record_failure(code_key, _CODE_WINDOW_SECS)
            raise

    # Clear any legacy lockout state left on the row by older builds.
    if user.failed_logins or user.locked_until:
        user.failed_logins = 0
        user.locked_until = None
        await db.commit()


async def _check_second_factor(db: AsyncSession, user: User, code: str | None) -> None:
    """TOTP, or a recovery code in its place, for an account that has 2FA on.
    A no-op otherwise."""
    if not user.totp_enabled:
        return
    supplied = (code or "").strip()
    if not supplied:
        raise HTTPException(status_code=401, detail="Invalid 2FA code")
    if not await _totp_ok(user, supplied):
        # A recovery code is the documented way back in when the
        # authenticator is gone. Spent on use, and only ever accepted for
        # an account that actually has TOTP on.
        if not await _redeem_backup_code(db, user, supplied):
            raise HTTPException(status_code=401, detail="Invalid 2FA code")
        log.info("auth.backup_code_redeemed", user_id=user.id)


@router.post("/refresh", response_model=TokenOut)
async def refresh(
    request: Request,
    response: Response,
    paiso_refresh: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
):
    if not paiso_refresh:
        raise HTTPException(status_code=401, detail="No refresh token")
    try:
        payload = decode_token(paiso_refresh)
        if payload.get("type") != "refresh":
            raise ValueError
        user_id = int(payload["sub"])
        family = payload["family"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    row = await db.scalar(select(RefreshToken).where(RefreshToken.family == family))
    user = await db.get(User, user_id)
    now = datetime.now(timezone.utc)
    if (
        row is None
        or row.user_id != user_id
        or row.revoked_at is not None
        or (_aware(row.expires_at) or now) < now
        or not user
        or not user.is_active
        or payload.get("epoch") != user.token_family
    ):
        raise HTTPException(status_code=401, detail="Session expired")

    presented = _sha256(paiso_refresh)
    new_refresh = create_refresh_token(user.id, family, epoch=user.token_family)
    # Compare and swap in one statement: the row changes only if it still
    # holds the token this request presented. Reading the hash and writing the
    # new one separately let two requests with the same token both rotate it
    #.
    rotated = None
    if secrets.compare_digest(row.token_hash, presented):
        rotated = await db.scalar(
            update(RefreshToken)
            .where(
                RefreshToken.id == row.id,
                RefreshToken.token_hash == presented,
                RefreshToken.revoked_at.is_(None),
            )
            .values(
                token_hash=_sha256(new_refresh),
                last_used_at=now,
                expires_at=now + timedelta(days=settings.jwt_refresh_expire_days),
            )
            .returning(RefreshToken.id)
        )
    if rotated is None:
        # A previously-rotated token was replayed (or lost the race to its own
        # copy) — likely theft. Kill the whole device session; the legitimate
        # holder re-authenticates.
        await db.execute(
            update(RefreshToken).where(RefreshToken.id == row.id).values(revoked_at=now)
        )
        await db.commit()
        raise HTTPException(status_code=401, detail="Session expired")
    await db.commit()

    access = create_access_token(user.id, user.token_family, sid=family)
    _set_refresh_cookie(response, new_refresh, request)
    return TokenOut(access_token=access)


@router.post("/logout")
async def logout(
    response: Response,
    paiso_refresh: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
):
    if paiso_refresh:
        try:
            family = decode_token(paiso_refresh).get("family")
            row = await db.scalar(select(RefreshToken).where(RefreshToken.family == family))
            if row and row.revoked_at is None:
                row.revoked_at = datetime.now(timezone.utc)
                await db.commit()
        except Exception:
            pass
    response.delete_cookie("paiso_refresh")
    return {"ok": True}


@router.post("/password")
async def change_password(
    body: PasswordChangeIn,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await check_rate(f"pwd:{user.id}")
    if not user.hashed_password:
        raise HTTPException(
            status_code=400,
            detail="This account has no password yet. Set one with python -m app.cli reset-password.",
        )
    if not await verify_password_async(body.current_password, user.hashed_password):
        raise HTTPException(status_code=400, detail="Current password incorrect")
    _require_password_policy(body.new_password, user.email)
    user.hashed_password = await hash_password_async(body.new_password)
    user.must_change_password = False
    # Every other device is signed out; this one gets a fresh session so it
    # survives. (It used to get a refresh cookie with no session row behind
    # it, which the next refresh rejected: changing your password signed you
    # out within the hour.)
    access = await _rotate_sessions(user, response, db, request)
    return {"ok": True, "access_token": access}


@router.get("/sessions")
async def session_count(
    paiso_refresh: str | None = Cookie(default=None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The devices that hold a live session, this one included: how many, and
    when each signed in and was last used. `current` marks the one
    whose refresh cookie came with this request."""
    now = datetime.now(timezone.utc)
    rows = (await db.scalars(
        select(RefreshToken).where(
            RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)
        )
    )).all()
    live = [r for r in rows if (_aware(r.expires_at) or now) > now]
    here = None
    if paiso_refresh:
        try:
            here = decode_token(paiso_refresh).get("family")
        except Exception:
            here = None
    # This device first, then the most recently used, so the five the page
    # shows before "Show all" are the ones worth reading.
    live.sort(
        key=lambda r: (r.family == here, _aware(r.last_used_at or r.created_at) or now),
        reverse=True,
    )
    return {
        "active": len(live),
        "sessions": [
            {
                "id": r.id,
                "signed_in_at": _aware(r.created_at),
                "last_active_at": _aware(r.last_used_at or r.created_at),
                "current": r.family == here,
                "device": device_label(r.user_agent),
            }
            for r in live
        ],
    }


@router.post("/sessions/revoke-others")
async def revoke_other_sessions(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Sign out everywhere except here."""
    await check_rate(f"revoke_sessions:{user.id}", max_calls=10)
    access = await _rotate_sessions(user, response, db, request)
    log.info("auth.sessions_revoked", user_id=user.id)
    return {"ok": True, "access_token": access}


@router.get("/me")
async def me(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    out = _profile_out(user)
    # When the account was opened: the client shows new-user tips only to
    # recent accounts.
    out["created_at"] = user.created_at.isoformat() if user.created_at else None
    return out


@router.patch("/me")
async def update_profile(
    body: ProfileUpdateIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    data = body.model_dump(exclude_unset=True)
    if "first_name" in data:
        user.first_name = (data["first_name"] or "").strip() or None
    if "last_name" in data:
        user.last_name = (data["last_name"] or "").strip() or None
    if "dob" in data:
        user.dob = data["dob"]
    if "phone" in data:
        user.phone = (data["phone"] or "").strip() or None

    await db.commit()
    return _profile_out(user)


@router.post("/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await check_rate(f"upload:avatar:{user.id}", max_calls=UPLOAD_RATE["avatar"])
    contents = await read_capped(file, _MAX_AVATAR_BYTES, "The photo")
    # The bytes decide the type, not the label the browser put on them.
    kind = sniff_image(contents)
    if kind is None:
        raise HTTPException(status_code=400, detail="Avatar must be a PNG, JPEG, WebP, or GIF image")
    encoded = base64.b64encode(contents).decode("ascii")
    user.avatar = f"data:{kind};base64,{encoded}"
    await db.commit()
    return {"avatar": user.avatar}


@router.delete("/me/avatar")
async def delete_avatar(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    user.avatar = None
    await db.commit()
    return {"ok": True}


@router.post("/totp/enroll")
async def totp_enroll(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    await check_rate(f"totp_enroll:{user.id}", max_calls=10)
    # Replacing the secret of an authenticator that is on would let a stolen
    # session take over the second factor. Turning it off asks for the
    # password and a code first (totp_disable).
    if user.totp_enabled:
        raise HTTPException(
            status_code=409,
            detail="Two-factor sign-in is already on. Turn it off before you set it up again.",
        )
    secret = generate_totp_secret()
    user.totp_secret = encrypt_totp_secret(secret)
    await db.commit()
    return {"provisioning_uri": totp_provisioning_uri(secret, user.email)}


@router.post("/totp/verify")
async def totp_verify(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    await check_rate(f"totp_verify:{user.id}")
    # Enrolment only. With 2FA already on, this used to hand out a fresh set
    # of recovery codes with no password, which regenerate_backup_codes asks
    # for.
    if user.totp_enabled:
        raise HTTPException(
            status_code=409,
            detail="Two-factor sign-in is already on. Turn it off before you set it up again.",
        )
    code = body.get("code", "")
    if not await _totp_ok(user, code):
        raise HTTPException(status_code=400, detail="Invalid code")
    user.totp_enabled = True
    # Issued here, at the one moment we know the user has a working
    # authenticator and is looking at the screen. Shown once and never again.
    codes = await _issue_backup_codes(db, user)
    await db.commit()
    return {"ok": True, "backup_codes": codes}


@router.post("/totp/disable")
async def totp_disable(
    body: ReauthIn | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from app.models.user import UserBackupCode

    was_enabled = user.totp_enabled
    if was_enabled:
        await _require_reauth(db, user, body or ReauthIn())
    user.totp_enabled = False
    user.totp_secret = None
    # Recovery codes only ever stand in for a TOTP code, so leaving them behind
    # after disabling would leave a second, invisible way in.
    for row in (await db.scalars(
        select(UserBackupCode).where(UserBackupCode.user_id == user.id)
    )).all():
        await db.delete(row)
    await db.commit()
    if was_enabled:
        log.info("auth.totp_disabled", user_id=user.id)
    return {"ok": True}


@router.get("/totp/backup-codes")
async def backup_code_status(
    db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)
):
    """How many codes remain. Never the codes themselves — only hashes are kept."""
    from app.models.user import UserBackupCode

    rows = (await db.scalars(
        select(UserBackupCode).where(UserBackupCode.user_id == user.id)
    )).all()
    return {
        "total": len(rows),
        "remaining": sum(1 for r in rows if r.used_at is None),
    }


@router.post("/totp/backup-codes")
async def regenerate_backup_codes(
    body: ReauthIn | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Issue a fresh set, invalidating every previous code.

    Requires TOTP to be on: recovery codes exist to recover *from* an
    authenticator, and handing them to an account without one would be a
    second password rather than a second factor.
    """
    await check_rate(f"backup_codes:{user.id}", max_calls=5, window_secs=3600)
    if not user.totp_enabled:
        raise HTTPException(
            status_code=400,
            detail="Enable two-factor authentication before generating recovery codes.",
        )
    await _require_reauth(db, user, body or ReauthIn())
    codes = await _issue_backup_codes(db, user)
    await db.commit()
    log.info("auth.backup_codes_regenerated", user_id=user.id)
    return {"backup_codes": codes}


@router.delete("/data")
async def reset_data(
    body: ReauthIn | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Erase all user data but keep the account. Idempotent."""
    await _require_reauth_destructive(db, user, body or ReauthIn())
    await _wipe_user_data(user.id, db)
    # Re-seed a clean settings row and default categories
    db.add(UserSettings(user_id=user.id))
    await db.flush()
    await seed_default_categories(user.id, db)
    await db.commit()
    return {"ok": True}


@router.delete("/account")
async def delete_account(
    response: Response,
    body: ReauthIn | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Permanently delete the account and all associated data."""
    await _require_reauth_destructive(db, user, body or ReauthIn())
    await delete_user_completely(db, user)
    await db.commit()
    response.delete_cookie("paiso_refresh")
    return {"ok": True}


def _is_https(request: Request | None) -> bool:
    """Whether the browser reached the app over HTTPS, directly or through a
    proxy that says so in ``X-Forwarded-Proto``."""
    if request is None:
        return True
    if request.url.scheme == "https":
        return True
    forwarded = request.headers.get("x-forwarded-proto", "")
    return forwarded.split(",")[0].strip().lower() == "https"


def _set_refresh_cookie(response: Response, token: str, request: Request | None = None) -> None:
    """The refresh cookie, which keeps a session across reloads.

    ``Secure`` whenever the browser came over HTTPS. Over plain HTTP a browser
    refuses a ``Secure`` cookie (except on localhost), so a self-hosted copy
    reached at ``http://<address>:8080`` signed the user out on every reload;
    there it is set without the flag. The README says to use HTTPS for
    anything beyond this machine.
    """
    from app.core.config import settings
    response.set_cookie(
        "paiso_refresh",
        token,
        httponly=True,
        secure=_is_https(request),
        samesite="strict",
        max_age=settings.jwt_refresh_expire_days * 86400,
    )

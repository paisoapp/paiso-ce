import asyncio
import base64
import hashlib
import secrets
from concurrent.futures import ThreadPoolExecutor
from secrets import token_hex as secrets_token_hex
from datetime import datetime, timedelta, timezone

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
import jwt

from app.core.config import settings

_ph = PasswordHasher(memory_cost=65536, time_cost=3, parallelism=2)


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, plain)
    except VerifyMismatchError:
        return False


_dummy_hash: str | None = None


def burn_password_check(plain: str) -> None:
    """Spend the time of one password check when there is no hash to check
    against (no such account, or one without a hash), so sign-in takes as long
    for an address that has no password as for one that does."""
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = _ph.hash("paiso-timing-equaliser")
    verify_password(plain, _dummy_hash)


# ── Async forms, off the event loop ────────────────────────────────────────
#
# One Argon2 check takes tens of milliseconds of CPU and 64 MB (memory_cost
# above). Run inline in an async route it stalled every other request, so a
# burst of sign-in attempts slowed the whole app. These run in a pool of two
# threads: enough that sign-ins do not queue behind each other in normal use,
# few enough that a burst cannot ask for gigabytes at once.

_hash_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="argon2")


async def _in_pool(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(_hash_pool, fn, *args)


async def hash_password_async(password: str) -> str:
    return await _in_pool(hash_password, password)


async def verify_password_async(plain: str, hashed: str) -> bool:
    return await _in_pool(verify_password, plain, hashed)


async def burn_password_check_async(plain: str) -> None:
    await _in_pool(burn_password_check, plain)


def create_access_token(subject: int, family: str, sid: str | None = None) -> str:
    # "fam" mirrors user.token_family so rotating the family revokes live
    # access tokens immediately (checked per-request in get_current_user),
    # not just refresh tokens.
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_access_expire_minutes)
    return jwt.encode(
        {
            "sub": str(subject), "exp": expire, "type": "access", "fam": family,
            # The device session (refresh_token.family) this token came from.
            # get_current_user refuses the token once that session ends, so
            # logging out ends it at once, not when it expires.
            **({"sid": sid} if sid else {}),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )


def create_refresh_token(subject: int, family: str, epoch: str | None = None) -> str:
    """`family` is the per-device session id (a refresh_token row); `epoch`
    mirrors user.token_family so a global revocation also kills refreshes."""
    expire = datetime.now(timezone.utc) + timedelta(
        days=settings.jwt_refresh_expire_days
    )
    payload = {
        "sub": str(subject),
        "exp": expire,
        "type": "refresh",
        "family": family,
        # jti: exp has 1s resolution, so without this two rotations inside the
        # same second would mint byte-identical tokens and defeat replay
        # detection (which compares stored vs presented token hashes).
        "jti": secrets_token_hex(8),
    }
    if epoch is not None:
        payload["epoch"] = epoch
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])


def generate_totp_secret() -> str:
    return pyotp.random_base32()


# ── TOTP secret encryption at rest ──────────────────────────────────────────
# Secrets are stored as "enc:<fernet>" when PAISO_MASTER_KEY is set; plaintext
# legacy rows are re-encrypted by a startup hook and still verify meanwhile.

_TOTP_ENC_PREFIX = "enc:"


def _totp_fernet() -> Fernet | None:
    if not settings.master_key:
        return None
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.master_key.encode()).digest())
    return Fernet(key)


def encrypt_totp_secret(secret: str) -> str:
    f = _totp_fernet()
    if not f:
        return secret
    return _TOTP_ENC_PREFIX + f.encrypt(secret.encode()).decode()


def decrypt_totp_secret(stored: str) -> str:
    if not stored or not stored.startswith(_TOTP_ENC_PREFIX):
        return stored
    f = _totp_fernet()
    if not f:
        raise ValueError("encrypted TOTP secret but PAISO_MASTER_KEY is unset")
    try:
        return f.decrypt(stored[len(_TOTP_ENC_PREFIX):].encode()).decode()
    except InvalidToken as e:
        raise ValueError("TOTP secret cannot be decrypted (wrong PAISO_MASTER_KEY?)") from e


def verify_totp(secret: str, code: str) -> bool:
    """Accepts the stored form — encrypted or legacy plaintext."""
    try:
        secret = decrypt_totp_secret(secret)
    except ValueError:
        return False
    return pyotp.TOTP(secret).verify(code, valid_window=1)


def totp_provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="Paiso")


# ── Recovery codes ──────────────────────────────────────────────────────────
#
# A single-use stand-in for a TOTP code, so losing an authenticator is not a
# hard lockout. Generated at enrolment and regenerable on demand; only the
# hashes are stored, so a lost list can be replaced but never recovered.

#: Crockford-ish: no I, L, O, U, 0 or 1, because these get read aloud and
#: copied off a screen by hand.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
_CODE_GROUPS = 3
_CODE_GROUP_LEN = 4
BACKUP_CODE_COUNT = 10


def generate_backup_code() -> str:
    """A 12-character code in three dashed groups (~59 bits of entropy)."""
    body = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_GROUPS * _CODE_GROUP_LEN))
    return "-".join(
        body[i : i + _CODE_GROUP_LEN] for i in range(0, len(body), _CODE_GROUP_LEN)
    )


def normalize_backup_code(code: str) -> str:
    """Accept what a human types: any case, spaces or dashes, or neither."""
    return "".join(c for c in (code or "").upper() if c in _CODE_ALPHABET)


def hash_backup_code(code: str) -> str:
    """SHA-256 of the normalized code.

    Deliberately not Argon2: these are high-entropy random strings, not chosen
    passwords, and a login attempt may have to check ten of them.
    """
    return hashlib.sha256(normalize_backup_code(code).encode()).hexdigest()

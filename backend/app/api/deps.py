from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWTError as JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.security import decode_token
from app.models.account import Account
from app.models.auth_session import RefreshToken
from app.models.user import User

bearer = HTTPBearer(auto_error=False)

# Endpoints a user may still call while a forced action is pending. Everything
# else 403s with a machine-readable detail the frontend redirects on.
_PWD_CHANGE_ALLOWED_PATHS = {
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/password",
}
_MFA_ENROLL_ALLOWED_PATHS = {
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/totp/enroll",
    "/api/auth/totp/verify",
}


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    token = credentials.credentials if credentials else None
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_token(token)
        if payload.get("type") != "access":
            raise ValueError("wrong token type")
        user_id = int(payload["sub"])
    except (JWTError, ValueError, KeyError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    user = await db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # Session revocation: access tokens carry the user's token_family ("fam").
    # Rotating the family (password change, sign out everywhere, CLI reset)
    # invalidates every outstanding token immediately. Tokens minted before
    # this claim existed are rejected too — one forced re-login at deploy.
    if payload.get("fam") != user.token_family:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")
    # Per-device revocation: the token names its device session ("sid"), and
    # ending that session (logout, a detected refresh replay, removing the
    # device) ends the token too, instead of leaving it usable until it
    # expires. A token with no sid predates this check; the client's
    # 401 handler refreshes and gets one that has it.
    sid = payload.get("sid")
    session_live = sid and await db.scalar(
        select(RefreshToken.id).where(
            RefreshToken.family == sid,
            RefreshToken.user_id == user_id,
            RefreshToken.revoked_at.is_(None),
        )
    )
    if not session_live:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session revoked")

    path = request.url.path
    # An account without a password hash has no current password to change
    # from, so a forced change cannot apply to it (see _profile_out in
    # app.api.auth).
    if user.must_change_password and user.hashed_password and path not in _PWD_CHANGE_ALLOWED_PATHS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="password_change_required")
    if user.mfa_required and not user.totp_enabled and path not in _MFA_ENROLL_ALLOWED_PATHS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="mfa_enrollment_required")
    return user


async def get_user_account_ids(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[int]:
    """Return all Account IDs belonging to the current user."""
    return list(
        (await db.scalars(select(Account.id).where(Account.user_id == user.id))).all()
    )


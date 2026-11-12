"""Access tokens for tests that call signed-in routes without signing in.

An app access token names the device session it came from ("sid"), and
get_current_user refuses it unless that refresh_token row exists and is not
revoked. Tests that mint a token directly create the row here.
"""
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token
from app.models.auth_session import RefreshToken


async def app_token(db: AsyncSession, user_id: int, family: str) -> str:
    """A bearer token for `user_id` backed by a live device session. Commits."""
    sid = secrets.token_hex(16)
    db.add(RefreshToken(
        user_id=user_id,
        family=sid,
        token_hash="0" * 64,
        expires_at=datetime.now(timezone.utc) + timedelta(days=1),
    ))
    await db.commit()
    return create_access_token(user_id, family, sid=sid)


async def app_headers(maker, user_id: int, family: str) -> dict[str, str]:
    """The Authorization header for `user_id`, opening its own session."""
    async with maker() as s:
        return {"Authorization": f"Bearer {await app_token(s, user_id, family)}"}

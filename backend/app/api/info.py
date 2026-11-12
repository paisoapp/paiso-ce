"""Build identity.

  GET /api/info        — public (no auth, like /healthz). Only what the app
                         needs before sign-in: the version string, the
                         channel, and whether sign-up is still open.

The public payload used to carry all of it: 146 KB naming the branch, 87
history rows and flag descriptions that named server secrets.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.core.version import build_info

router = APIRouter(prefix="/api/info", tags=["info"])


@router.get("")
async def get_info(db: AsyncSession = Depends(get_db)):
    from app.api.auth import signup_closed

    info = build_info()
    return {
        # False once the install has its one account; the sign-in page then
        # leaves out the sign-up link.
        "signup_open": not await signup_closed(db),
        # version_string ends in the short commit, which is what a runbook
        # checks after a deploy.
        "version": info["version"],
        "version_string": info["version_string"],
        "channel": info["channel"],
    }

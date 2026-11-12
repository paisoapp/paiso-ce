"""User settings & profile endpoints."""
import json
from typing import Optional
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.settings import UserSettings
from app.models.user import User

router = APIRouter(prefix="/api/settings", tags=["settings"])


class ProfileUpdate(BaseModel):
    theme: Optional[str] = None
    theme_variant: Optional[str] = None
    ui_prefs: Optional[dict] = None


def _settings_out(s: UserSettings) -> dict:
    return {
        "theme": s.theme,
        "theme_variant": s.theme_variant,
        "ui_prefs": json.loads(s.ui_prefs) if s.ui_prefs else {},
    }


# Lists in the onboarding blob that only ever grow: a tip once dismissed, or a
# setup step once done, stays that way. The client saves the whole blob, so a
# tab or device holding an older copy would otherwise put a dismissed tip back.
_ONBOARDING_GROW_ONLY = ("seenTips", "completedSteps")


def merge_ui_prefs(existing: dict, incoming: dict) -> dict:
    """Merge a ui_prefs update into the stored prefs. Top-level keys replace
    the stored ones, except that the onboarding lists in
    `_ONBOARDING_GROW_ONLY` keep every id either side holds."""
    merged = {**existing, **incoming}
    old = existing.get("onboarding")
    new = incoming.get("onboarding")
    if isinstance(old, dict) and isinstance(new, dict):
        onboarding = {**new}
        for key in _ONBOARDING_GROW_ONLY:
            ids = [*(new.get(key) or []), *(old.get(key) or [])]
            onboarding[key] = list(dict.fromkeys(ids))
        merged["onboarding"] = onboarding
    return merged


@router.get("/profile")
async def get_profile(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if not s:
        s = UserSettings(user_id=user.id)
        db.add(s)
        await db.commit()
        await db.refresh(s)
    return _settings_out(s)


@router.patch("/profile")
async def update_profile(
    body: ProfileUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    s = await db.scalar(select(UserSettings).where(UserSettings.user_id == user.id))
    if not s:
        s = UserSettings(user_id=user.id)
        db.add(s)

    updates = body.model_dump(exclude_none=True)

    # ui_prefs is a free-form JSON blob stored as text; merge the incoming keys
    # into any existing prefs so partial updates (e.g. only the nav state) don't
    # wipe unrelated keys (e.g. the remembered date range).
    ui_prefs = updates.pop("ui_prefs", None)
    if ui_prefs is not None:
        existing = json.loads(s.ui_prefs) if s.ui_prefs else {}
        s.ui_prefs = json.dumps(merge_ui_prefs(existing, ui_prefs))

    for field, value in updates.items():
        setattr(s, field, value)

    await db.commit()
    await db.refresh(s)
    return _settings_out(s)

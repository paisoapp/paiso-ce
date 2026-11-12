"""The user's own today.

The server runs on UTC, so from 7 pm in Chicago ``date.today()`` is already
tomorrow: the Budget tab counted the wrong days left, moved to the next month
early on a month's last evening, and refused edits to a month the user was
still in. The browser sends its UTC offset on every request
(``X-Timezone-Offset``, minutes as ``Date.getTimezoneOffset`` gives them, so
Chicago in summer sends 300). ``ClockMiddleware`` keeps it for the request and
``local_today`` turns it into the user's date. Without the header, as in
background jobs and tests, it is the server's date as before.
"""
from contextvars import ContextVar
from datetime import date, datetime, timedelta, timezone
from typing import Optional

HEADER = "x-timezone-offset"

# Offsets run from UTC-12 to UTC+14; anything outside is ignored.
_MIN_OFFSET, _MAX_OFFSET = -14 * 60, 12 * 60

_offset: ContextVar[Optional[int]] = ContextVar("timezone_offset", default=None)


def parse_offset(value: Optional[str]) -> Optional[int]:
    """Minutes behind UTC from the header, or None when missing or invalid."""
    try:
        minutes = int(value) if value is not None else None
    except ValueError:
        return None
    if minutes is None or not _MIN_OFFSET <= minutes <= _MAX_OFFSET:
        return None
    return minutes


def local_today() -> date:
    """Today where the user is, or the server's today without an offset."""
    minutes = _offset.get()
    if minutes is None:
        return date.today()
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).date()


def set_offset(minutes: Optional[int]):
    """Use `minutes` for this context; returns the token to reset it."""
    return _offset.set(minutes)


class ClockMiddleware:
    """Keeps the request's UTC offset for ``local_today`` (pure ASGI, so it
    also covers streaming responses)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        raw = dict(scope.get("headers") or []).get(HEADER.encode())
        token = _offset.set(parse_offset(raw.decode() if raw else None))
        try:
            await self.app(scope, receive, send)
        finally:
            _offset.reset(token)

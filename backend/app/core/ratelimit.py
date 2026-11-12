"""Fixed-window rate limiter, counted in this process.

One process runs the app, so its counts are the whole picture. They reset when
the app restarts, which costs an attacker nothing they could not get by
waiting out the window.
"""
import threading
import time

from fastapi import HTTPException, Request

from app.core.config import settings

_TOO_MANY = "Too many attempts. Please try again later."

_lock = threading.Lock()
#: key -> (count, window end on the monotonic clock)
_counts: dict[str, tuple[int, float]] = {}
#: Past this many keys, expired windows are dropped before a new one is added.
#: Every failed sign-in with a new address adds a key, so without the sweep
#: the table would grow for as long as someone kept guessing.
_SWEEP_AT = 10_000


def _sweep(now: float) -> None:
    for k in [k for k, (_, exp) in _counts.items() if exp <= now]:
        del _counts[k]


def _count(rkey: str) -> int:
    with _lock:
        n, expires = _counts.get(rkey, (0, 0.0))
        return n if expires > time.monotonic() else 0


def _incr(rkey: str, window_secs: int, sliding: bool = False) -> int:
    """Count one against `rkey`. The window starts at the first count, or with
    `sliding`, restarts at every count, so the key lasts `window_secs` after
    the most recent one."""
    with _lock:
        n, expires = _counts.get(rkey, (0, 0.0))
        now = time.monotonic()
        if expires <= now:
            if rkey not in _counts and len(_counts) >= _SWEEP_AT:
                _sweep(now)
            n, expires = 0, now + window_secs
        n += 1
        if sliding:
            expires = now + window_secs
        _counts[rkey] = (n, expires)
        return n


def client_ip(request: Request) -> str:
    """The address a per-client limit should be keyed on.

    Behind a proxy ``request.client.host`` is the proxy, which would put every
    visitor in one bucket. ``PAISO_TRUSTED_IP_HEADER`` names the header the edge
    sets to the real address (``CF-Connecting-IP`` behind Cloudflare, which
    overwrites whatever the client sent). It is empty by default because a
    deployment with no such edge would be trusting a header anyone can forge.
    """
    header = settings.trusted_ip_header
    if header:
        value = (request.headers.get(header) or "").split(",")[0].strip()
        if value:
            return value
    return request.client.host if request.client else "unknown"


async def check_rate(key: str, max_calls: int = 5, window_secs: int = 300) -> None:
    """Count this call and raise 429 once `key` has exceeded `max_calls` in the
    current window."""
    if _incr(f"paiso:rl:{key}", window_secs) > max_calls:
        raise HTTPException(status_code=429, detail=_TOO_MANY)


async def check_failures(key: str, max_failures: int) -> None:
    """Raise 429 when `key` already has `max_failures` recorded, without
    counting this call.

    The pair with :func:`record_failure` limits *failed* attempts only. A
    sign-in limit that counted every attempt would lock out an office behind
    one address, or a person who signs in often; one that counts failures
    costs an honest user nothing and an attacker every guess.
    """
    if _count(f"paiso:rl:{key}") >= max_failures:
        raise HTTPException(status_code=429, detail=_TOO_MANY)


async def failure_count(key: str) -> int:
    """How many failures `key` currently has in its window, without counting
    this call. Used by sign-in to decide whether a challenge is required
    before it will accept further attempts."""
    return _count(f"paiso:rl:{key}")


async def record_failure(key: str, window_secs: int = 300, *, sliding: bool = False) -> None:
    """Count one failed attempt against `key`. With `sliding`, the count lasts
    `window_secs` after the latest failure rather than the first, so steady
    guessing keeps the limit in force while a quiet key clears."""
    _incr(f"paiso:rl:{key}", window_secs, sliding)


async def first_use(key: str, window_secs: int) -> bool:
    """True the first time `key` is seen within `window_secs`, False after.
    Used to make a one-time code single-use for as long as it would otherwise
    stay valid."""
    return _incr(f"paiso:once:{key}", window_secs) == 1


async def reset_failures(*keys: str) -> None:
    """Clear failure counters for `keys`, called after a successful sign-in so
    an earlier run of bad attempts stops requiring a challenge."""
    with _lock:
        for k in keys:
            _counts.pop(f"paiso:rl:{k}", None)

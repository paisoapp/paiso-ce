"""In-process JSON cache (sync).

Used by market-data code that runs in worker threads and executors, so it is a
plain dict behind a lock. One process runs the app, so one dict is the whole
cache. Values are stored as JSON, so a caller never shares a mutable object
with another.
"""
import json
import threading
import time
from typing import Any

_lock = threading.Lock()
#: key -> (JSON text, expiry on the monotonic clock or None)
_store: dict[str, tuple[str, float | None]] = {}
#: Past this many keys, expired entries are dropped before a new one is added.
_SWEEP_AT = 10_000


def _live(key: str) -> str | None:
    entry = _store.get(key)
    if entry is None:
        return None
    raw, expires = entry
    if expires is not None and expires <= time.monotonic():
        del _store[key]
        return None
    return raw


def cache_get(key: str) -> Any | None:
    with _lock:
        raw = _live(key)
    return json.loads(raw) if raw is not None else None


def cache_set(key: str, value: Any, ttl_seconds: int | None = None) -> None:
    raw = json.dumps(value, default=str)
    now = time.monotonic()
    expires = now + ttl_seconds if ttl_seconds else None
    with _lock:
        if key not in _store and len(_store) >= _SWEEP_AT:
            for k in [k for k, (_, exp) in _store.items() if exp is not None and exp <= now]:
                del _store[k]
        _store[key] = (raw, expires)


def cache_delete(*keys: str) -> None:
    with _lock:
        for key in keys:
            _store.pop(key, None)


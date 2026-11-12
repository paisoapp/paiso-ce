"""File storage: user-owned files (transaction attachments, account logos,
asset thumbnails) on local disk under ``PAISO_STORAGE_ROOT``, the data volume.

Key scheme:
    attachments/{user_id}/{txn_id}/{stored_name}
    logos/{account_id}{ext}
    thumbnails/{filename}
    imports/{user_id}/{upload_id}  (CSV wizard staging)
"""
import asyncio
import shutil
from pathlib import Path
from typing import Protocol

import structlog

from app.core.config import settings

log = structlog.get_logger()


def _reject_unsafe_key(key: str) -> None:
    """Defence in depth against path traversal in a storage key.

    Callers build keys from ids and server-generated names, never from a raw
    client string — but if one slips through, a ``..`` segment or an absolute
    path must never reach the filesystem or an S3 object key. The local backend
    also confines to the root below; this adds the same floor for S3, whose
    object keys have no root to be relative to."""
    parts = key.replace("\\", "/").split("/")
    if key.startswith("/") or ".." in parts:
        raise ValueError(f"unsafe storage key: {key!r}")


class Storage(Protocol):
    async def put(self, key: str, data: bytes) -> None: ...
    async def get(self, key: str) -> bytes | None: ...
    async def delete(self, key: str) -> None: ...
    async def delete_prefix(self, prefix: str) -> None: ...
    async def exists(self, key: str) -> bool: ...
    async def list_prefix(self, prefix: str) -> list[tuple[str, float]]: ...


class LocalDiskStorage:
    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _path(self, key: str) -> Path:
        _reject_unsafe_key(key)
        p = (self.root / key).resolve()
        if not p.is_relative_to(self.root.resolve()):
            raise ValueError(f"unsafe storage key: {key!r}")
        return p

    async def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(p.write_bytes, data)

    async def get(self, key: str) -> bytes | None:
        p = self._path(key)
        if not p.is_file():
            return None
        return await asyncio.to_thread(p.read_bytes)

    async def delete(self, key: str) -> None:
        p = self._path(key)
        if p.is_file():
            p.unlink(missing_ok=True)

    async def delete_prefix(self, prefix: str) -> None:
        p = self._path(prefix)
        if p.is_dir():
            await asyncio.to_thread(shutil.rmtree, p, True)
        elif p.is_file():
            p.unlink(missing_ok=True)

    async def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    async def list_prefix(self, prefix: str) -> list[tuple[str, float]]:
        """Every file under `prefix`, as (key, modified time in epoch seconds).
        Used by the nightly sweep for files no row owns."""
        base = self._path(prefix)
        root = self.root.resolve()

        def _walk() -> list[tuple[str, float]]:
            if not base.is_dir():
                return []
            return [
                (p.relative_to(root).as_posix(), p.stat().st_mtime)
                for p in base.rglob("*") if p.is_file()
            ]

        return await asyncio.to_thread(_walk)


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = LocalDiskStorage(settings.storage_root)
    return _storage

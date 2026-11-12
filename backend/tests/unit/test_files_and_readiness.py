"""Stored files, positions-only statements and readiness.

- no stored file outlives its row, and the nightly sweep removes the rest
- readiness reports a database that refuses writes, and a full disk
"""
import time

import pytest
from sqlalchemy import select

from app.core import storage
from app.models.transaction import Transaction, TransactionAttachment

from tests.unit.test_upload_limits import (  # noqa: F401  (fixtures)
    PDF,
    _f,
    client,
    maker,
    world,
)

pytestmark = pytest.mark.unit


class TimedStorage:
    """In-memory storage that also records when each file was written."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.mtimes: dict[str, float] = {}

    async def put(self, key, data):
        self.files[key] = data
        self.mtimes[key] = time.time()

    async def get(self, key):
        return self.files.get(key)

    async def delete(self, key):
        self.files.pop(key, None)
        self.mtimes.pop(key, None)

    async def delete_prefix(self, prefix):
        for k in [k for k in self.files if k.startswith(prefix)]:
            await self.delete(k)

    async def exists(self, key):
        return key in self.files

    async def list_prefix(self, prefix):
        return [(k, self.mtimes[k]) for k in self.files if k.startswith(prefix)]


@pytest.fixture
def store(client, monkeypatch):
    s = TimedStorage()
    monkeypatch.setattr(storage, "_storage", s)
    return s


async def _attach(client, txn_id: int) -> None:
    r = await client.post(f"/api/transactions/{txn_id}/attachments",
                          files=_f("receipt.pdf", PDF, "application/pdf"))
    assert r.status_code in (200, 201), r.text


# ── No file outlives its row ─────────────────────────────────────

async def test_deleting_a_transaction_deletes_its_receipt_files(client, world, store):
    await _attach(client, world["txn"])
    assert any(k.startswith("attachments/") for k in store.files)
    r = await client.delete(f"/api/transactions/{world['txn']}")
    assert r.status_code == 204
    assert not any(k.startswith("attachments/") for k in store.files)


async def test_deleting_an_account_deletes_its_receipt_files(client, world, store, maker):
    from app.api.accounts import delete_account_and_children
    from app.models.account import Account

    await _attach(client, world["txn"])
    async with maker() as s:
        await delete_account_and_children(s, await s.get(Account, world["account"]))
        await s.commit()
    assert not any(k.startswith("attachments/") for k in store.files)


async def test_the_sweep_removes_only_what_nothing_owns(client, world, store, maker):
    from app.modules.maintenance.files import sweep_orphaned_files

    await _attach(client, world["txn"])
    owned = next(k for k in store.files if k.startswith("attachments/"))
    orphan_old = f"attachments/{world['user']}/999/old.pdf"
    orphan_new = f"attachments/{world['user']}/999/new.pdf"
    csv_old = f"imports/{world['user']}/00000000-0000-4000-8000-000000000001"
    csv_new = f"imports/{world['user']}/00000000-0000-4000-8000-000000000002"
    now = time.time()
    for key, age in ((orphan_old, 7200), (orphan_new, 60), (csv_old, 90000), (csv_new, 600)):
        await store.put(key, b"x")
        store.mtimes[key] = now - age
    store.mtimes[owned] = now - 99999  # old, but a row names it

    async with maker() as s:
        out = await sweep_orphaned_files(s, now=now)
    assert out["attachments"] == 1 and out["staged_csvs"] == 1
    assert set(store.files) == {owned, orphan_new, csv_new}
    async with maker() as s:
        assert (await s.scalar(select(TransactionAttachment))) is not None
        assert (await s.get(Transaction, world["txn"])) is not None


async def test_local_disk_lists_a_prefix_with_times(tmp_path):
    disk = storage.LocalDiskStorage(tmp_path)
    await disk.put("imports/1/a", b"x")
    await disk.put("imports/2/b", b"y")
    await disk.put("attachments/1/9/r.pdf", b"z")
    listed = dict(await disk.list_prefix("imports/"))
    assert set(listed) == {"imports/1/a", "imports/2/b"}
    assert all(abs(t - time.time()) < 60 for t in listed.values())
    assert await disk.list_prefix("nothing-here/") == []


# ── Readiness checks writes and disk ────────────────────────────────────

async def test_a_read_only_sqlite_database_is_reported(tmp_path, monkeypatch):
    import sqlite3

    from sqlalchemy.ext.asyncio import create_async_engine

    import app.main as main
    from app.core import database

    path = tmp_path / "ro.db"
    sqlite3.connect(path).execute("CREATE TABLE t (x INTEGER)").connection.commit()

    rw = create_async_engine(f"sqlite+aiosqlite:///{path}")
    monkeypatch.setattr(database, "engine", rw)
    assert await main._db_write_problem() is None
    await rw.dispose()
    # The probe leaves nothing behind.
    tables = {r[0] for r in sqlite3.connect(path).execute("SELECT name FROM sqlite_master")}
    assert tables == {"t"}

    ro = create_async_engine(f"sqlite+aiosqlite:///file:{path}?mode=ro&uri=true")
    monkeypatch.setattr(database, "engine", ro)
    assert (await main._db_write_problem()).startswith("not writable")
    await ro.dispose()


def test_low_disk_is_reported(monkeypatch, tmp_path):
    import shutil
    from collections import namedtuple

    import app.main as main
    from app.core.config import settings

    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(10, 9, 500 * 1024 * 1024))
    assert main._disk_problem() == "low (500 MB free)"
    monkeypatch.setattr(shutil, "disk_usage", lambda p: usage(10, 1, 5 * 1024 ** 3))
    assert main._disk_problem() is None


async def test_readyz_answers_503_and_names_the_failing_check(monkeypatch):
    import json

    import app.main as main

    async def fine_db():
        return None

    monkeypatch.setattr(main, "_db_write_problem", fine_db)
    monkeypatch.setattr(main, "_disk_problem", lambda: "low (500 MB free)")
    r = await main.readyz()
    body = json.loads(r.body)
    assert r.status_code == 503 and body["checks"]["disk"] == "low (500 MB free)"

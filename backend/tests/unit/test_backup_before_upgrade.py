"""The database is copied before a migration changes it (app/core/migrations.py)."""
import sqlite3
import stat

import pytest

from app.core import migrations
from app.core.config import settings

pytestmark = pytest.mark.unit


def _db(path, value):
    con = sqlite3.connect(str(path))
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS t (v TEXT)")
    con.execute("INSERT INTO t VALUES (?)", (value,))
    con.commit()
    return con  # left open, as the app's own connection would be


def test_an_existing_database_is_copied_and_later_copies_do_not_replace_it(tmp_path, monkeypatch):
    db = tmp_path / "paiso.db"
    con = _db(db, "first")
    monkeypatch.setattr(settings, "sqlite_path", str(db))
    monkeypatch.setattr(settings, "storage_root", str(tmp_path))
    monkeypatch.setattr(settings, "app_version", "0.2.0")

    first = migrations.backup_before_upgrade()
    con.execute("INSERT INTO t VALUES ('second')")
    con.commit()
    second = migrations.backup_before_upgrade()
    con.close()

    assert first.name == "pre-0.2.0.db" and second.name == "pre-0.2.0-2.db"
    assert stat.S_IMODE(first.stat().st_mode) == 0o600
    rows = sqlite3.connect(str(first)).execute("SELECT v FROM t").fetchall()
    assert rows == [("first",)]  # the WAL contents are in the copy


def test_a_new_install_has_nothing_to_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "sqlite_path", str(tmp_path / "none.db"))
    monkeypatch.setattr(settings, "storage_root", str(tmp_path))
    assert migrations.backup_before_upgrade() is None
    assert not (tmp_path / "backups").exists()

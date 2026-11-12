"""Alembic migration runner.

Called at API startup and usable standalone:

    python -m app.core.migrations

A new install is created from the baseline revision (``0001``) and upgraded
through any later ones; an existing one is upgraded to head, after a copy of
its database is saved to ``<storage root>/backups/pre-<version>.db``.
"""
import sqlite3
from pathlib import Path

import structlog
from alembic import command
from alembic.config import Config
from alembic.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine

from app.core.config import settings

log = structlog.get_logger()

# backend/ — where alembic.ini and alembic/ live.
_BACKEND_DIR = Path(__file__).resolve().parents[2]


def _alembic_config() -> Config:
    cfg = Config(str(_BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(_BACKEND_DIR / "alembic"))
    return cfg


def backup_before_upgrade() -> Path | None:
    """Copy the database before a migration changes it.

    SQLite's online backup API, so the copy is consistent even in WAL mode.
    The file is named for the version being started; a second upgrade to the
    same version gets ``-2``, ``-3`` and so on rather than replacing the
    first copy. Returns the copy's path, or None when there is no database
    file yet (a new install).
    """
    source = Path(settings.sqlite_path)
    if not source.is_file():
        return None
    folder = Path(settings.storage_root) / "backups"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = folder / f"pre-{settings.app_version}.db"
    n = 2
    while target.exists():
        target = folder / f"pre-{settings.app_version}-{n}.db"
        n += 1
    src = sqlite3.connect(str(source))
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    target.chmod(0o600)
    return target


def upgrade_to_head() -> None:
    """Bring the database to the latest Alembic revision.

    Safe to call on every startup; a no-op when already at head.
    """
    cfg = _alembic_config()
    engine = create_engine(settings.sync_database_url)
    try:
        with engine.connect() as conn:
            current = MigrationContext.configure(conn).get_current_revision()
        head = ScriptDirectory.from_config(cfg).get_current_head()
        if current == head:
            return
        if current is not None:
            log.info("database backed up before upgrade", path=str(backup_before_upgrade()))
        log.info("running alembic upgrade", from_rev=current, to_rev=head)
        command.upgrade(cfg, "head")
    finally:
        engine.dispose()


if __name__ == "__main__":
    upgrade_to_head()

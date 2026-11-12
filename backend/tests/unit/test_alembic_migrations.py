"""Alembic schema guard: head must build a database that matches the models.

Runs `alembic upgrade head` against a throwaway SQLite file and asserts that
(a) every model table exists and (b) `alembic check` detects no drift between
Base.metadata and the migrated schema. Fails whenever someone changes a model
without writing a revision (or vice versa).
"""
import pytest

pytestmark = pytest.mark.unit


def _fresh_settings(tmp_path):
    from app.core.config import settings

    old = settings.sqlite_path
    settings.sqlite_path = str(tmp_path / "alembic_head.db")
    return old


def test_upgrade_head_matches_models(tmp_path):
    from alembic import command
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine, inspect

    from app.core.config import settings
    from app.core.database import Base
    from app.core.migrations import _alembic_config
    import app.models  # noqa: F401 — registers all tables on Base.metadata

    old_path = _fresh_settings(tmp_path)
    try:
        command.upgrade(_alembic_config(), "head")

        engine = create_engine(settings.sync_database_url)
        with engine.connect() as conn:
            actual_tables = set(inspect(conn).get_table_names())
            expected_tables = set(Base.metadata.tables)
            missing = expected_tables - actual_tables
            assert not missing, f"tables missing after upgrade head: {sorted(missing)}"

            diffs = compare_metadata(
                MigrationContext.configure(
                    conn, opts={"compare_type": False}
                ),
                Base.metadata,
            )
            assert not diffs, f"schema drift between migrations and models: {diffs}"
        engine.dispose()
    finally:
        settings.sqlite_path = old_path


def test_startup_creates_a_new_database_and_is_idempotent(tmp_path):
    """upgrade_to_head builds an empty file from the baseline, and a second
    call is a no-op."""
    import logging

    from sqlalchemy import create_engine, inspect

    from app.core.config import settings
    from app.core.migrations import upgrade_to_head

    logging.getLogger("uvicorn.error")  # exists before startup, as under uvicorn
    old_path = _fresh_settings(tmp_path)
    try:
        upgrade_to_head()
        upgrade_to_head()
        # Migrating in-process must not silence uvicorn's error log.
        assert not logging.getLogger("uvicorn.error").disabled
        engine = create_engine(settings.sync_database_url)
        with engine.connect() as conn:
            insp = inspect(conn)
            assert insp.has_table("alembic_version")
            assert insp.has_table("user")
        engine.dispose()
    finally:
        settings.sqlite_path = old_path


def test_0002_adds_new_default_categories_to_an_existing_account(tmp_path):
    """An account seeded before Education, Rent and Childcare joined the
    defaults gets them under its Expense group; one that already has Rent
    keeps its own."""
    from alembic import command
    from sqlalchemy import create_engine, text

    from app.core.config import settings
    from app.core.migrations import _alembic_config

    old_path = _fresh_settings(tmp_path)
    try:
        command.upgrade(_alembic_config(), "0001")
        engine = create_engine(settings.sync_database_url)
        # SQLite leaves foreign keys off here, so the categories need no user rows.
        with engine.begin() as conn:
            for uid in (1, 2):
                conn.execute(text(
                    "INSERT INTO category (id, user_id, name, is_income, treatment, is_group, position)"
                    " VALUES (:g, :u, 'Expense', 0, 'expense', 1, 0)"
                ), {"g": uid * 100, "u": uid})
                conn.execute(text(
                    "INSERT INTO category (user_id, name, parent_id, is_income, treatment, is_group, position)"
                    " VALUES (:u, 'Groceries', :g, 0, 'expense', 0, 4)"
                ), {"u": uid, "g": uid * 100})
            conn.execute(text(
                "INSERT INTO category (user_id, name, parent_id, is_income, treatment, is_group, position)"
                " VALUES (2, 'rent', 200, 0, 'expense', 0, 5)"
            ))

        command.upgrade(_alembic_config(), "head")

        with engine.connect() as conn:
            rows = conn.execute(text(
                "SELECT user_id, name, parent_id, position FROM category"
                " WHERE lower(name) IN ('education', 'rent', 'childcare') ORDER BY user_id, position"
            )).all()
        engine.dispose()
        assert [tuple(r) for r in rows] == [
            (1, "Education", 100, 5),
            (1, "Rent", 100, 6),
            (1, "Childcare", 100, 7),
            (2, "rent", 200, 5),
            (2, "Education", 200, 6),
            (2, "Childcare", 200, 7),
        ]
    finally:
        settings.sqlite_path = old_path

from contextlib import asynccontextmanager
from typing import AsyncIterator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import NullPool

from app.core.config import settings

engine = create_async_engine(
    settings.database_url,
    echo=False,
    # Bound values stay out of exception messages and logs: a failed INSERT
    # used to carry transaction descriptions and amounts into the log and an
    # HTTP 500 body. The SQL text itself is still shown.
    hide_parameters=True,
    # check_same_thread: aiosqlite runs the connection in a worker thread.
    # timeout: wait up to 15s for a write lock to clear instead of failing
    # immediately with "database is locked" under concurrent writes.
    connect_args={"check_same_thread": False, "timeout": 15},
)

# Per-connection SQLite tuning. The default settings are conservative and cause
# spurious "database is locked" errors when two requests write concurrently
# (e.g. a market refresh while an avatar upload commits).
@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _connection_record):
    cursor = dbapi_conn.cursor()
    # Foreign keys are off by default; enable so ON DELETE CASCADE works.
    cursor.execute("PRAGMA foreign_keys=ON")
    # WAL lets readers run concurrently with a single writer.
    cursor.execute("PRAGMA journal_mode=WAL")
    # Wait (ms) for a held lock rather than erroring out instantly. This
    # backs up the connect-time timeout for locks hit mid-transaction.
    cursor.execute("PRAGMA busy_timeout=15000")
    cursor.close()

AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


@asynccontextmanager
async def task_session() -> AsyncIterator[AsyncSession]:
    """Session for code running under ``asyncio.run()`` (scheduled job bodies).

    The global engine's connection pool is bound to the event loop it was first
    used on. Every fresh loop therefore gets its own throwaway engine, disposed
    on exit. NullPool: nothing to keep warm for a one-shot loop.
    """
    engine_ = create_async_engine(
        settings.database_url,
        echo=False,
        hide_parameters=True,
        poolclass=NullPool,
        connect_args={"check_same_thread": False, "timeout": 15},
    )
    try:
        async with async_sessionmaker(engine_, expire_on_commit=False)() as session:
            yield session
    finally:
        await engine_.dispose()

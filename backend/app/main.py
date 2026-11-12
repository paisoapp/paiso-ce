import asyncio
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from sqlalchemy import select, text


from app.api.accounts import router as accounts_router
from app.api.assets import router as assets_router
from app.api.settings import router as settings_router
from app.api.dashboard import router as dashboard_router
from app.api.auth import router as auth_router
from app.api.budget import router as budget_router
from app.api.categories import router as categories_router
from app.api.categories import rules_router as category_rules_router
from app.api.holdings import router as holdings_router
from app.api.investments_overview import router as investments_overview_router
from app.api.investment_income import router as investment_income_router
from app.api.investment_activity import router as investment_activity_router
from app.api.imports import router as imports_router
from app.api.market import router as market_router
from app.api.portfolio import router as portfolio_router
from app.api.portfolio_trend import router as portfolio_trend_router
from app.api.mortgage import router as mortgage_router
from app.api.transactions import router as transactions_router
from app.api.transfers import router as transfers_router
from app.api.info import router as info_router

from app.core.clock import ClockMiddleware
from app.core.security_headers import SecurityHeadersMiddleware
from app.core.body_limit import BodyLimitMiddleware
from app.core.config import settings
from app.core.instance_secrets import is_unset
from app.core.spa import mount_spa

log = structlog.get_logger()

# Interactive API docs are a development tool: the schema they publish covers
# every route. Dev keeps them; a prod build does not.
_DOCS_ENABLED = settings.release_channel != "prod"

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Runs :func:`startup` (defined below) before the first request, then
    starts the scheduled jobs (``app.workers.scheduler``); stops them on
    shutdown."""
    await startup()
    if settings.scheduler:
        from app.workers import scheduler

        scheduler.start()
    yield
    if settings.scheduler:
        from app.workers import scheduler

        scheduler.stop()


app = FastAPI(
    lifespan=_lifespan,
    title="Paiso API",
    version=settings.app_version,
    docs_url="/api/docs" if _DOCS_ENABLED else None,
    redoc_url="/api/redoc" if _DOCS_ENABLED else None,
    openapi_url="/api/openapi.json" if _DOCS_ENABLED else None,
)

# Only when another origin is configured: the app is served from its own.
if settings.allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept", "X-Timezone-Offset"],
    )
# The user's own date for "today": see app/core/clock.py.
app.add_middleware(ClockMiddleware)
# Security headers on every response: no proxy in front is assumed.
app.add_middleware(SecurityHeadersMiddleware)
# A ceiling on request bodies, for the same reason.
app.add_middleware(BodyLimitMiddleware)
# Compress responses: there may be no proxy in front to do it.
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Routers
app.include_router(auth_router)
app.include_router(accounts_router)
app.include_router(categories_router)
app.include_router(category_rules_router)
app.include_router(imports_router)
app.include_router(transactions_router)
# Transfer pairing belongs to the budgeting section: it exists to keep
# movements out of income and expense totals.
app.include_router(transfers_router)
app.include_router(budget_router)
app.include_router(holdings_router)
app.include_router(investments_overview_router)
app.include_router(investment_income_router)
app.include_router(investment_activity_router)
app.include_router(market_router)
app.include_router(assets_router)
app.include_router(portfolio_router)
app.include_router(portfolio_trend_router)
app.include_router(dashboard_router)
app.include_router(settings_router)
app.include_router(mortgage_router)
app.include_router(info_router)



async def startup():
    if is_unset(settings.jwt_secret):
        msg = (
            "INSECURE CONFIGURATION: no sign-in secret. The data volume "
            f"({settings.storage_root}) is missing or read-only, so none could be "
            "generated, and PAISO_JWT_SECRET is not set."
        )
        # Fail fast in a release image: a default secret means every sign-in
        # token can be forged. Dev runs with a warning for convenience.
        if settings.release_channel == "prod":
            raise RuntimeError(msg)
        log.error(msg)

    if settings.auto_migrate:
        # Alembic is the schema source of truth: it creates a new database from
        # the baseline and applies any later revisions (app.core.migrations).
        from app.core.migrations import upgrade_to_head

        await asyncio.to_thread(upgrade_to_head)

        await _migrate_categories()
        await _encrypt_totp_secrets()

    log.info(
        "Paiso API started",
        version=settings.app_version,
        channel=settings.release_channel,
    )


async def _encrypt_totp_secrets() -> None:
    """One-time hook: encrypt legacy plaintext TOTP secrets at rest.

    Idempotent — encrypted values carry an "enc:" prefix and are skipped.
    No-op when PAISO_MASTER_KEY is unset (dev)."""
    if not settings.master_key:
        return
    from app.core.database import AsyncSessionLocal
    from app.core.security import encrypt_totp_secret
    from app.models.user import User

    async with AsyncSessionLocal() as db:
        users = (await db.scalars(
            select(User).where(User.totp_secret.is_not(None))
        )).all()
        changed = 0
        for u in users:
            if u.totp_secret and not u.totp_secret.startswith("enc:"):
                u.totp_secret = encrypt_totp_secret(u.totp_secret)
                changed += 1
        if changed:
            await db.commit()
            log.info("encrypted legacy TOTP secrets", count=changed)


async def _migrate_categories() -> None:
    """Ensure every existing user has the full standard subcategory set.

    Safe to run repeatedly — only inserts missing categories.
    Never deletes or renames existing categories (preserves user transactions).
    """
    from app.core.database import AsyncSessionLocal
    from app.modules.accounts.seed_categories import (
        _INCOME_CHILDREN, _EXPENSE_CHILDREN, _TRANSFER_CHILDREN,
    )

    # (root name, is_income, treatment, icon, color, children, child_color)
    PARENTS = [
        ("Income",   True,  "income",   "trending-up",   "#22c55e", _INCOME_CHILDREN,   "#16a34a"),
        ("Expense",  False, "expense",  "trending-down", "#3b82f6", _EXPENSE_CHILDREN,  "#2563eb"),
        ("Transfer", False, "transfer", "repeat",        "#94a3b8", _TRANSFER_CHILDREN, "#64748b"),
    ]

    async with AsyncSessionLocal() as db:
        rows = (await db.execute(text("SELECT DISTINCT user_id FROM category"))).fetchall()

        for (uid,) in rows:
            # Ensure the three root categories exist first (needed for re-homing).
            root_ids: dict[str, int] = {}
            for (pname, p_is_income, treatment, p_icon, p_color, children, c_color) in PARENTS:
                parent = (await db.execute(
                    text("SELECT id FROM category WHERE user_id=:u AND name=:n AND parent_id IS NULL"),
                    {"u": uid, "n": pname},
                )).fetchone()
                if not parent:
                    await db.execute(text(
                        "INSERT INTO category (user_id, name, is_income, treatment, icon, color) "
                        "VALUES (:u, :n, :i, :t, :ic, :c)"
                    ), {"u": uid, "n": pname, "i": int(p_is_income), "t": treatment, "ic": p_icon, "c": p_color})
                    await db.commit()
                    parent = (await db.execute(
                        text("SELECT id FROM category WHERE user_id=:u AND name=:n AND parent_id IS NULL"),
                        {"u": uid, "n": pname},
                    )).fetchone()
                root_ids[pname] = parent[0]

            # One-time re-home/rename of the two reimbursement categories.
            # Both moves are guarded so they are no-ops once applied (idempotent),
            # and they reuse the existing category id so transaction history follows.
            transfer_id = root_ids["Transfer"]
            await db.execute(text(
                "UPDATE category SET name='Reimbursement', parent_id=:tid, treatment='transfer' "
                "WHERE user_id=:u AND name='Expense Reimbursement' "
                "AND NOT EXISTS (SELECT 1 FROM category c2 WHERE c2.user_id=:u AND c2.name='Reimbursement')"
            ), {"u": uid, "tid": transfer_id})
            await db.execute(text(
                "UPDATE category SET name='Refunds', parent_id=:tid, treatment='transfer' "
                "WHERE user_id=:u AND name='Refunds & Reimbursements' "
                "AND NOT EXISTS (SELECT 1 FROM category c2 WHERE c2.user_id=:u AND c2.name='Refunds')"
            ), {"u": uid, "tid": transfer_id})

            # Ensure missing children exist, then backfill treatment across the tree.
            for (pname, p_is_income, treatment, p_icon, p_color, children, c_color) in PARENTS:
                pid = root_ids[pname]
                existing = {r[0] for r in (await db.execute(
                    text("SELECT name FROM category WHERE user_id=:u AND parent_id=:p"),
                    {"u": uid, "p": pid},
                )).fetchall()}

                for name in children:
                    if name not in existing:
                        await db.execute(text(
                            "INSERT INTO category (user_id, parent_id, name, is_income, treatment, icon, color) "
                            "VALUES (:u, :p, :n, :i, :t, :ic, :c)"
                        ), {"u": uid, "p": pid, "n": name, "i": int(p_is_income), "t": treatment, "ic": "circle", "c": c_color})

                # Stamp treatment on every root with this name and all their
                # children that don't have it yet. Name-based (not just root_ids[pname])
                # so duplicate root categories — a pre-existing data anomaly for some
                # users — are also covered, keeping transfers correctly excluded.
                await db.execute(text(
                    "UPDATE category SET treatment=:t "
                    "WHERE user_id=:u AND parent_id IS NULL AND name=:n AND (treatment IS NULL OR treatment='')"
                ), {"u": uid, "t": treatment, "n": pname})
                await db.execute(text(
                    "UPDATE category SET treatment=:t "
                    "WHERE user_id=:u AND (treatment IS NULL OR treatment='') AND parent_id IN "
                    "(SELECT id FROM category WHERE user_id=:u AND parent_id IS NULL AND name=:n)"
                ), {"u": uid, "t": treatment, "n": pname})

        await db.commit()


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


#: Below this much free space on the data disk, readiness reports degraded.
#: The database shares the data volume with uploaded files, and SQLite
#: refuses writes on a full disk.
_READY_MIN_FREE_BYTES = 1024 ** 3


async def _db_write_problem() -> str | None:
    """Why the database would refuse a write, or None. Writes nothing: a
    schema change inside a transaction that is always rolled back. A
    read-only file refuses it; BEGIN IMMEDIATE alone does not."""
    from app.core.database import engine

    async with engine.connect() as conn:
        try:
            await conn.exec_driver_sql("BEGIN")
            try:
                await conn.exec_driver_sql("CREATE TABLE main._readyz_probe (x INTEGER)")
            finally:
                await conn.exec_driver_sql("ROLLBACK")
        except Exception as exc:  # noqa: BLE001
            return f"not writable: {exc.__class__.__name__}"
    return None


def _disk_problem() -> str | None:
    """Low free space on the data volume, or None."""
    import shutil

    try:
        free = shutil.disk_usage(settings.storage_root).free
    except OSError as exc:
        return f"error: {exc.__class__.__name__}"
    if free < _READY_MIN_FREE_BYTES:
        return f"low ({free // (1024 * 1024)} MB free)"
    return None


@app.get("/readyz")
async def readyz():
    """Real readiness: database reachable, writable and at the Alembic head,
    and the data disk not nearly full. /healthz stays trivial (liveness), so a
    full disk does not restart the container in a loop."""
    from fastapi.responses import JSONResponse

    from app.core.database import AsyncSessionLocal

    checks: dict[str, str] = {}
    ok = True

    try:
        async with AsyncSessionLocal() as db:
            await db.execute(text("SELECT 1"))
            current = (
                await db.execute(text("SELECT version_num FROM alembic_version"))
            ).scalar()
        from alembic.script import ScriptDirectory

        from app.core.migrations import _alembic_config

        head = ScriptDirectory.from_config(_alembic_config()).get_current_head()
        if current == head:
            checks["db"] = "ok"
        else:
            checks["db"] = f"schema behind head ({current} != {head})"
            ok = False
    except Exception as exc:
        checks["db"] = f"error: {exc.__class__.__name__}"
        ok = False

    # A database that answers reads but refuses writes (a replica, a
    # read-only file) used to read as ready while every import failed
    #.
    if checks.get("db") == "ok":
        try:
            problem = await _db_write_problem()
        except Exception as exc:
            problem = f"error: {exc.__class__.__name__}"
        if problem:
            checks["db"] = problem
            ok = False

    disk = _disk_problem()
    checks["disk"] = disk or "ok"
    if disk:
        ok = False

    return JSONResponse(
        {"status": "ok" if ok else "degraded", "checks": checks},
        status_code=200 if ok else 503,
    )


# The built web app, last: its catch-all route must not shadow any API route.
mount_spa(app, settings.static_dir)

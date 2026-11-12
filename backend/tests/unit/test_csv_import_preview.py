"""The CSV import says what it will do before it does it.

A file Paiso recognised was imported the moment it was dropped, and the rows
it could not read were left out without a word: the audit's ten-row file
came back "8 transactions imported".
"""
from decimal import Decimal

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import imports as imports_api
from app.api.deps import get_current_user
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.user import User
from app.modules.aggregator.csv_parsers import unreadable_rows

pytestmark = pytest.mark.unit

# The audit's file: Unicode merchants, a day-first and an ISO date, a quoted
# thousands amount, an amount that is not a number, a missing date, and a
# description that is a spreadsheet formula.
AUDIT_FILE = """Date,Description,Amount
10/01/2026,Café Rosé,-12.50
10/02/2026,Ünïcödé Mart,-8.25
13/10/2026,Day-first date,-3.00
2026-10-04,ISO date,-4.00
10/05/2026,Paycheck,"2,500.00"
10/06/2026,Bad amount,abc
,No date,-1.00
10/08/2026,"=HYPERLINK(""http://example.com"")",-2.00
10/09/2026,Groceries,-45.10
10/10/2026,Coffee,-3.75
"""


@pytest.fixture
async def sessionmaker(tmp_path):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'csv.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def account_id(sessionmaker):
    async with sessionmaker() as db:
        u = User(email="csv@example.com", hashed_password="x", token_family="f")
        db.add(u)
        await db.flush()
        a = Account(user_id=u.id, display_name="Checking", account_type="checking", current_balance=Decimal("110"))
        db.add(a)
        await db.commit()
        return a.id


@pytest.fixture
async def client(sessionmaker, account_id):
    app = FastAPI()
    app.include_router(imports_api.router)

    async def _db():
        async with sessionmaker() as s:
            yield s

    async def _user():
        async with sessionmaker() as s:
            return await s.scalar(select(User))

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user] = _user
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test"
    ) as c:
        yield c


async def _post(client, account_id, *, preview: bool):
    data = {"account_id": str(account_id)}
    if preview:
        data["preview"] = "true"
    return await client.post(
        "/api/imports/bank-csv", data=data,
        files={"file": ("statement.csv", AUDIT_FILE.encode(), "text/csv")},
    )


async def _count(sessionmaker, account_id) -> int:
    async with sessionmaker() as db:
        return await db.scalar(
            select(func.count()).select_from(Transaction).where(Transaction.account_id == account_id)
        )


def test_every_row_left_out_is_named_with_its_reason():
    count, rows = unreadable_rows(AUDIT_FILE)
    assert count == 10
    by_line = {r["line"]: r["reason"] for r in rows}
    assert set(by_line) == {7, 8}
    assert "abc" in by_line[7] and "not a number" in by_line[7]
    assert by_line[8] == "It has no date."


def test_a_clean_file_reports_nothing_left_out():
    assert unreadable_rows("Date,Description,Amount\n10/01/2026,Coffee,-3.75\n") == (1, [])


async def test_the_preview_writes_nothing_and_says_what_the_import_will_do(client, sessionmaker, account_id):
    r = await _post(client, account_id, preview=True)
    assert r.status_code == 200, r.text
    out = r.json()
    assert (out["row_count"], out["new_count"], out["duplicate_count"]) == (10, 8, 0)
    assert [u["line"] for u in out["unreadable"]] == [7, 8]
    # Newest first: the day-first "13/10/2026" is 13 October.
    assert [x["date"] for x in out["sample"]] == [
        "2026-10-13", "2026-10-10", "2026-10-09", "2026-10-08", "2026-10-05"]
    assert out["balance_found"] is False
    assert await _count(sessionmaker, account_id) == 0, "a preview imports nothing"

    # Confirm imports exactly what the preview promised.
    r = await _post(client, account_id, preview=False)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 8
    assert await _count(sessionmaker, account_id) == 8

    # The same file again: all of it is already there.
    out = (await _post(client, account_id, preview=True)).json()
    assert (out["new_count"], out["duplicate_count"]) == (0, 8)

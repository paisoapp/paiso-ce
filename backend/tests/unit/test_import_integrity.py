"""Import integrity and ownership: staged files, transfer pairing, amounts, duplicates.

A3  a staged CSV belongs to the user who uploaded it
#6  a transfer-matcher failure does not undo a committed import
#5  non-finite amounts are refused by every parser
P1  a database error carries no SQL parameters into the response
I1  repeated purchases in one file keep their own rows
"""
import math
from datetime import date

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import auth as auth_api
from app.api import imports as imports_api
from app.core import ratelimit, storage
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.transaction import Transaction
from app.models.user import User

from tests.unit.session_tokens import app_headers
pytestmark = pytest.mark.unit


class MemoryStorage:
    def __init__(self):
        self.files: dict[str, bytes] = {}

    async def put(self, key, data):
        self.files[key] = data

    async def get(self, key):
        return self.files.get(key)

    async def delete(self, key):
        self.files.pop(key, None)

    async def delete_prefix(self, prefix):
        for k in [k for k in self.files if k.startswith(prefix)]:
            del self.files[k]

    async def exists(self, key):
        return key in self.files


@pytest.fixture
def mem():
    return MemoryStorage()


@pytest.fixture
async def maker(tmp_path, monkeypatch, mem):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'imports.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(ratelimit, "_counts", {})
    monkeypatch.setattr(storage, "_storage", mem)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def world(maker):
    async with maker() as s:
        a = User(email="a@example.com", hashed_password="x", token_family="fa")
        b = User(email="b@example.com", hashed_password="x", token_family="fb")
        s.add_all([a, b])
        await s.flush()
        acct_a = Account(user_id=a.id, account_type="checking", display_name="A checking")
        acct_b = Account(user_id=b.id, account_type="checking", display_name="B checking")
        s.add_all([acct_a, acct_b])
        await s.commit()
        return {"a": a.id, "b": b.id, "acct_a": acct_a.id, "acct_b": acct_b.id}


def _app(maker) -> FastAPI:
    app = FastAPI()
    for module in (auth_api, imports_api):
        app.include_router(module.router)

    async def _db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    return app


@pytest.fixture
async def clients(maker, world):
    app = _app(maker)
    out = {}
    for who, fam in (("a", "fa"), ("b", "fb")):
        headers = await app_headers(maker, world[who], fam)
        out[who] = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="https://app.test", headers=headers
        )
    try:
        yield out
    finally:
        for c in out.values():
            await c.aclose()


MAP = {"date_posted": "Date", "description": "Description", "amount": "Amount", "balance": "Balance"}
PRIVATE_CSV = b"Date,Description,Amount,Balance\n2026-10-01,PRIVATE PHARMACY,-12.34,100.00\n"


async def _count(maker, account_id: int) -> int:
    async with maker() as s:
        return await s.scalar(
            select(func.count()).select_from(Transaction).where(Transaction.account_id == account_id)
        )


async def _upload(client, data: bytes) -> str:
    r = await client.post("/api/imports/csv", files={"file": ("s.csv", data, "text/csv")})
    assert r.status_code == 201, r.text
    return r.json()["upload_id"]


# ── A3: a staged CSV belongs to its uploader ────────────────────────────────

async def test_staged_csv_is_stored_under_the_uploader(clients, world, mem):
    upload_id = await _upload(clients["a"], PRIVATE_CSV)
    assert list(mem.files) == [f"imports/{world['a']}/{upload_id}"]


async def test_another_user_cannot_validate_or_commit_a_staged_csv(clients, world, maker, mem):
    upload_id = await _upload(clients["a"], PRIVATE_CSV)

    body = {"account_id": world["acct_b"], "column_map": {}}
    r = await clients["b"].post(f"/api/imports/csv/{upload_id}/validate", json=body)
    assert r.status_code == 404
    assert "PRIVATE PHARMACY" not in r.text

    body = {"account_id": world["acct_b"], "column_map": MAP}
    r = await clients["b"].post(f"/api/imports/csv/{upload_id}/commit", json=body)
    assert r.status_code == 404
    assert await _count(maker, world["acct_b"]) == 0
    # The owner's file is untouched and still imports.
    assert f"imports/{world['a']}/{upload_id}" in mem.files
    body = {"account_id": world["acct_a"], "column_map": MAP}
    r = await clients["a"].post(f"/api/imports/csv/{upload_id}/commit", json=body)
    assert r.status_code == 200 and r.json()["imported"] == 1
    assert mem.files == {}


@pytest.mark.parametrize("bad", ["not-a-uuid", "..", "%2e%2e", "123"])
async def test_a_malformed_upload_id_reads_as_missing(clients, world, bad):
    body = {"account_id": world["acct_a"], "column_map": MAP}
    r = await clients["a"].post(f"/api/imports/csv/{bad}/validate", json=body)
    assert r.status_code == 404


async def test_account_wipe_removes_staged_statements(clients, world, maker, mem):
    await _upload(clients["a"], PRIVATE_CSV)
    await _upload(clients["b"], PRIVATE_CSV)
    async with maker() as s:
        await auth_api._wipe_user_data(world["a"], s)
        await s.commit()
    assert [k for k in mem.files if k.startswith(f"imports/{world['a']}/")] == []
    assert [k for k in mem.files if k.startswith(f"imports/{world['b']}/")] != []


# ── #6: a matcher failure does not undo the import ──────────────────────────

@pytest.fixture
def broken_matcher(monkeypatch):
    from app.modules.budgeting import transfer_matcher

    calls = []

    async def boom(db, user_id, transaction_ids=None):
        calls.append(transaction_ids)
        raise RuntimeError("synthetic matcher failure")

    monkeypatch.setattr(transfer_matcher, "match_transfers", boom)
    return calls


async def test_csv_import_survives_a_matcher_failure(clients, world, maker, broken_matcher):
    data = (
        b"Date,Description,Amount,Balance\n"
        b"2026-10-01,COFFEE,-5.00,95.00\n"
        b"2026-10-02,GROCER,-20.00,75.00\n"
    )
    upload_id = await _upload(clients["a"], data)
    body = {"account_id": world["acct_a"], "column_map": MAP, "save_mapping": True}
    r = await clients["a"].post(f"/api/imports/csv/{upload_id}/commit", json=body)
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 2
    assert broken_matcher, "the matcher still runs"
    assert await _count(maker, world["acct_a"]) == 2
    async with maker() as s:
        acct = await s.get(Account, world["acct_a"])
        assert float(acct.current_balance) == 75.0


async def test_ofx_import_survives_a_matcher_failure(maker, world, broken_matcher):
    from pathlib import Path

    app = _app(maker)
    headers = await app_headers(maker, world['a'], 'fa')
    fixture = Path(__file__).parent.parent / "aggregator" / "fixtures" / "synthetic_checking_sgml.qfx"
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test", headers=headers
    ) as c:
        r = await c.post(
            "/api/imports/ofx",
            data={"account_id": str(world["acct_a"])},
            files={"file": ("s.qfx", fixture.read_bytes(), "application/octet-stream")},
        )
    assert r.status_code == 200, r.text
    imported = r.json()["imported"]
    assert imported > 0
    assert await _count(maker, world["acct_a"]) == imported


# ── #5: non-finite amounts are refused ──────────────────────────────────────

NON_FINITE = ["NaN", "nan", "inf", "-Infinity", "1e309", "1e13"]


@pytest.mark.parametrize("raw", NON_FINITE)
def test_every_amount_parser_refuses_non_finite_values(raw):
    from app.modules.accounts.csv_parser import _parse_amount
    from app.modules.aggregator.csv_parsers import _clean_amount
    from app.modules.aggregator.ofx_parser import _number, parse_ofx_amount

    with pytest.raises(ValueError):
        _parse_amount(raw)
    assert _clean_amount(raw) is None
    with pytest.raises(ValueError):
        parse_ofx_amount(raw)
    with pytest.raises(ValueError):
        _number(raw)


def test_ordinary_amounts_still_parse():
    from app.modules.accounts.csv_parser import _parse_amount
    from app.modules.aggregator.csv_parsers import _clean_amount
    from app.modules.aggregator.ofx_parser import _number, parse_ofx_amount

    assert _parse_amount("$1,234.56") == 1234.56
    assert _clean_amount("(99.00)") == -99.0
    assert parse_ofx_amount("1.234,56") == 1234.56
    assert _number("") == 0.0 and _number("12.5") == 12.5


async def test_mapped_csv_reports_a_nan_row_as_invalid(clients, world, maker):
    data = (
        b"Date,Description,Amount,Balance\n"
        b"2026-10-01,COFFEE,NaN,95.00\n"
        b"2026-10-02,GROCER,-20.00,75.00\n"
    )
    upload_id = await _upload(clients["a"], data)
    body = {"account_id": world["acct_a"], "column_map": MAP}
    r = await clients["a"].post(f"/api/imports/csv/{upload_id}/validate", json=body)
    assert r.status_code == 200
    assert r.json()["valid_count"] == 1
    assert [row["row_index"] for row in r.json()["invalid_rows"]] == [0]
    r = await clients["a"].post(f"/api/imports/csv/{upload_id}/commit", json=body)
    assert r.status_code == 200 and r.json()["imported"] == 1


async def test_smart_csv_skips_a_nan_row_and_keeps_the_rest(clients, world, maker):
    data = (
        b"Date,Description,Amount\n"
        b"10/01/2026,COFFEE,NaN\n"
        b"10/02/2026,GROCER,-20.00\n"
        b"10/03/2026,RENT,1e309\n"
    )
    r = await clients["a"].post(
        "/api/imports/bank-csv",
        data={"account_id": str(world["acct_a"])},
        files={"file": ("s.csv", data, "text/csv")},
    )
    assert r.status_code == 200, r.text
    assert await _count(maker, world["acct_a"]) == 1
    async with maker() as s:
        amounts = (await s.scalars(
            select(Transaction.amount).where(Transaction.account_id == world["acct_a"])
        )).all()
    assert all(math.isfinite(float(a)) for a in amounts)


# ── P1: no financial data in a database error ───────────────────────────────

def test_engines_hide_sql_parameters():
    from app.core import database

    assert database.engine.sync_engine.hide_parameters is True


async def test_bank_csv_save_error_does_not_echo_the_rows(clients, world, monkeypatch):
    from structlog.testing import capture_logs

    async def failing_classifier(description, *a, **kw):
        # What a DBAPI error looks like without hide_parameters.
        raise RuntimeError(f"INSERT INTO transactions ... parameters: ({description!r}, -12.34)")

    monkeypatch.setattr(imports_api, "classify_transaction", failing_classifier)
    data = b"Date,Description,Amount\n10/01/2026,PRIVATE PHARMACY,-12.34\n"
    with capture_logs() as logs:
        r = await clients["a"].post(
            "/api/imports/bank-csv",
            data={"account_id": str(world["acct_a"])},
            files={"file": ("s.csv", data, "text/csv")},
        )
    assert r.status_code == 500
    assert "PRIVATE PHARMACY" not in r.text and "INSERT" not in r.text
    errors = [e for e in logs if e.get("event") == "import_bank_csv.db_error"]
    assert errors and errors[0]["error"] == "RuntimeError"


# ── I1: repeated purchases keep their own rows ──────────────────────────────

TWO_COFFEES = (
    b"Date,Description,Amount,Balance\n"
    b"2026-10-01,COFFEE,-5.00,95.00\n"
    b"2026-10-01,COFFEE,-5.00,90.00\n"
)


def test_number_repeats_keeps_the_first_and_renames_the_rest():
    from app.modules.aggregator.csv_parsers import number_repeats

    ids = ["a" * 16, "b" * 16, "a" * 16, "a" * 16]
    out = number_repeats(ids)
    assert out[0] == ids[0] and out[1] == ids[1]
    assert len(set(out)) == 4
    assert all(len(x) == 16 for x in out)
    assert number_repeats(ids) == out  # same file, same ids


async def _commit_mapped(client, account_id: int, data: bytes) -> dict:
    upload_id = await _upload(client, data)
    body = {"account_id": account_id, "column_map": MAP, "save_mapping": False}
    r = await client.post(f"/api/imports/csv/{upload_id}/commit", json=body)
    assert r.status_code == 200, r.text
    return r.json()


async def test_mapped_csv_keeps_two_identical_coffees(clients, world, maker):
    assert (await _commit_mapped(clients["a"], world["acct_a"], TWO_COFFEES))["imported"] == 2
    async with maker() as s:
        acct = await s.get(Account, world["acct_a"])
        assert float(acct.current_balance) == 90.0
    # The same file again adds nothing.
    again = await _commit_mapped(clients["a"], world["acct_a"], TWO_COFFEES)
    assert (again["imported"], again["skipped"]) == (0, 2)
    assert await _count(maker, world["acct_a"]) == 2


async def test_reimport_heals_a_coffee_dropped_before_the_fix(clients, world, maker):
    # Before the fix both rows had the first row's id, so only one landed.
    from app.modules.accounts.csv_parser import _content_hash

    async with maker() as s:
        s.add(Transaction(
            account_id=world["acct_a"], date_posted=date(2026, 10, 1), amount=-5,
            description="COFFEE", balance=95, source="csv",
            external_id=_content_hash(world["acct_a"], date(2026, 10, 1), -5.0, "COFFEE"),
        ))
        await s.commit()
    result = await _commit_mapped(clients["a"], world["acct_a"], TWO_COFFEES)
    assert (result["imported"], result["skipped"]) == (1, 1)
    assert await _count(maker, world["acct_a"]) == 2


async def test_smart_csv_keeps_two_identical_coffees(clients, world, maker):
    data = b"Date,Description,Amount\n10/01/2026,COFFEE,-5.00\n10/01/2026,COFFEE,-5.00\n"
    for expected in (2, 2):  # second run imports nothing new
        r = await clients["a"].post(
            "/api/imports/bank-csv",
            data={"account_id": str(world["acct_a"])},
            files={"file": ("s.csv", data, "text/csv")},
        )
        assert r.status_code == 200, r.text
        assert await _count(maker, world["acct_a"]) == expected

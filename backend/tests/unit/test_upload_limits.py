"""Upload limits: sizes, types by their bytes, counts, quota and rate.

Each refusal named in docs/implemented/upload-limits.md has a test here.
"""
import io
import json
from datetime import date

import httpx
import pytest
from fastapi import FastAPI, UploadFile
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import app.models  # noqa: F401
from app.api import assets as assets_api
from app.api import auth as auth_api
from app.api import imports as imports_api
from app.api import transactions as transactions_api
from app.core import ratelimit, storage, uploads
from app.core.database import Base, get_db
from app.models.account import Account
from app.models.asset import Asset
from app.models.transaction import Transaction
from app.models.user import User

from tests.unit.session_tokens import app_headers
pytestmark = pytest.mark.unit

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 64
PDF = b"%PDF-1.7\n" + b"\0" * 64
HEIC = b"\0\0\0\x18ftypheic" + b"\0" * 64
HTML = b"<html><script>alert(1)</script></html>"


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
async def maker(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'uploads.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(ratelimit, "_counts", {})
    monkeypatch.setattr(storage, "_storage", MemoryStorage())
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest.fixture
async def world(maker):
    async with maker() as s:
        user = User(email="up@example.com", hashed_password="x", token_family="fam")
        s.add(user)
        await s.flush()
        acct = Account(user_id=user.id, account_type="checking", display_name="Checking")
        asset = Asset(user_id=user.id, name="House", category="primary_home", current_value=1)
        s.add_all([acct, asset])
        await s.flush()
        txn = Transaction(account_id=acct.id, date_posted=date(2026, 10, 1), amount=-5, description="Coffee")
        s.add(txn)
        await s.commit()
        return {"user": user.id, "account": acct.id, "asset": asset.id, "txn": txn.id}


@pytest.fixture
async def client(maker, world):
    app = FastAPI()
    for module in (auth_api, assets_api, imports_api, transactions_api):
        app.include_router(module.router)

    async def _db():
        async with maker() as s:
            yield s

    app.dependency_overrides[get_db] = _db
    headers = await app_headers(maker, world['user'], 'fam')
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="https://app.test", headers=headers
    ) as c:
        yield c


def _f(name: str, data: bytes, ctype: str = "application/octet-stream") -> dict:
    return {"file": (name, data, ctype)}


# ── Helpers ──────────────────────────────────────────────────────────────────

async def test_read_capped_stops_at_the_limit():
    ok = UploadFile(io.BytesIO(b"x" * 99))
    assert len(await uploads.read_capped(ok, 100)) == 99
    with pytest.raises(Exception) as e:
        await uploads.read_capped(UploadFile(io.BytesIO(b"x" * 100)), 100)
    assert e.value.status_code == 413


def test_sniffing_reads_the_bytes():
    assert uploads.sniff_image(PNG) == "image/png"
    assert uploads.sniff_image(JPEG) == "image/jpeg"
    assert uploads.sniff_image(b"RIFF\0\0\0\0WEBPVP8 ") == "image/webp"
    assert uploads.sniff_image(b"GIF89a....") == "image/gif"
    assert uploads.sniff_image(HTML) is None
    assert uploads.sniff_image(PDF) is None
    assert uploads.sniff_receipt(PDF) == "application/pdf"
    assert uploads.sniff_receipt(HEIC) == "image/heic"
    assert uploads.sniff_receipt(HTML) is None


# ── Profile photo ────────────────────────────────────────────────────────────

async def test_profile_photo_is_checked_by_its_bytes(client):
    r = await client.post("/api/auth/me/avatar", files=_f("a.png", HTML, "image/png"))
    assert r.status_code == 400
    r = await client.post("/api/auth/me/avatar", files=_f("a.gif", PNG, "image/gif"))
    assert r.status_code == 200 and r.json()["avatar"].startswith("data:image/png;")
    r = await client.post(
        "/api/auth/me/avatar", files=_f("a.png", PNG + b"\0" * uploads.AVATAR_MAX_BYTES, "image/png")
    )
    assert r.status_code == 413


# ── Receipts ─────────────────────────────────────────────────────────────────

async def test_receipts_are_photos_or_pdfs_under_5_mb(client, world):
    url = f"/api/transactions/{world['txn']}/attachments"
    r = await client.post(url, files=_f("page.html", HTML, "application/pdf"))
    assert r.status_code == 400
    r = await client.post(url, files=_f("big.pdf", PDF + b"\0" * uploads.RECEIPT_MAX_BYTES, "application/pdf"))
    assert r.status_code == 413
    r = await client.post(url, files=_f("receipt.heic", HEIC, "application/octet-stream"))
    assert r.status_code == 201
    assert r.json()["content_type"] == "image/heic"
    att = r.json()["id"]
    dl = await client.get(f"{url}/{att}/download")
    assert dl.headers["content-type"] == "image/heic"
    assert dl.headers["content-disposition"].startswith('attachment; filename="receipt.heic"')


def test_a_stored_name_cannot_break_the_download_header():
    header = transactions_api._attachment_disposition('a"; x=1\r\nSet-Cookie: y.pdf')
    assert "\r" not in header and "\n" not in header
    assert header.startswith('attachment; filename="a; x=1Set-Cookie: y.pdf"')
    assert "filename*=UTF-8''" in transactions_api._attachment_disposition("reçu.pdf")


async def test_a_transaction_holds_at_most_ten_receipts(client, world, monkeypatch):
    url = f"/api/transactions/{world['txn']}/attachments"
    for i in range(uploads.RECEIPTS_PER_TRANSACTION):
        assert (await client.post(url, files=_f(f"{i}.pdf", PDF))).status_code == 201
    r = await client.post(url, files=_f("one-more.pdf", PDF))
    assert r.status_code == 400 and "up to 10" in r.json()["detail"]


async def test_the_storage_quota_counts_receipts_and_photos(client, world, monkeypatch):
    monkeypatch.setattr(uploads, "USER_STORAGE_QUOTA_BYTES", len(PDF) + len(PNG))
    url = f"/api/transactions/{world['txn']}/attachments"
    assert (await client.post(url, files=_f("a.pdf", PDF))).status_code == 201
    assert (await client.post(f"/api/assets/{world['asset']}/thumbnail",
                              files=_f("h.png", PNG, "image/png"))).status_code == 200
    r = await client.post(url, files=_f("b.pdf", PDF))
    assert r.status_code == 413 and "limit" in r.json()["detail"]
    # Replacing the photo with one the same size still fits.
    assert (await client.post(f"/api/assets/{world['asset']}/thumbnail",
                              files=_f("h.png", PNG, "image/png"))).status_code == 200


async def test_uploads_are_rate_limited_per_user(client, world, monkeypatch):
    monkeypatch.setitem(uploads.UPLOAD_RATE, "receipt", 2)
    monkeypatch.setattr(uploads, "RECEIPTS_PER_TRANSACTION", 99)
    url = f"/api/transactions/{world['txn']}/attachments"
    assert (await client.post(url, files=_f("1.pdf", PDF))).status_code == 201
    assert (await client.post(url, files=_f("2.pdf", PDF))).status_code == 201
    assert (await client.post(url, files=_f("3.pdf", PDF))).status_code == 429


# ── Asset photos ─────────────────────────────────────────────────────────────

async def test_asset_photo_is_checked_by_its_bytes(client, world):
    url = f"/api/assets/{world['asset']}/thumbnail"
    assert (await client.post(url, files=_f("x.png", HTML, "image/png"))).status_code == 400
    r = await client.post(url, files=_f("x.png", PNG + b"\0" * uploads.ASSET_PHOTO_MAX_BYTES, "image/png"))
    assert r.status_code == 413
    r = await client.post(url, files=_f("x.gif", JPEG, "image/gif"))
    assert r.status_code == 200 and r.json()["url"].startswith("data:image/jpeg;")


async def test_a_client_cannot_set_the_recorded_photo_size(client, maker, world):
    url = f"/api/assets/{world['asset']}/thumbnail"
    assert (await client.post(url, files=_f("x.png", PNG, "image/png"))).status_code == 200

    async def meta():
        async with maker() as s:
            return json.loads((await s.get(Asset, world["asset"])).metadata_json)

    m = await meta()
    assert m["custom_thumbnail_bytes"] == len(PNG)
    m["custom_thumbnail_bytes"] = -10_000_000
    r = await client.patch(f"/api/assets/{world['asset']}", json={"metadata_json": m})
    assert r.status_code == 200, r.text
    assert (await meta())["custom_thumbnail_bytes"] == len(PNG)


# ── Imports ──────────────────────────────────────────────────────────────────

async def test_csv_imports_are_capped_at_5_mb(client, world):
    big = b"date,amount,description\n" + b"x" * uploads.CSV_MAX_BYTES
    r = await client.post("/api/imports/csv", files=_f("big.csv", big, "text/csv"))
    assert r.status_code == 413 and "under 5 MB" in r.json()["detail"]
    r = await client.post("/api/imports/bank-csv", data={"account_id": str(world["account"])},
                          files=_f("big.csv", big, "text/csv"))
    assert r.status_code == 413


async def test_statement_imports_are_capped_at_10_mb(client, world):
    big = b"OFXHEADER:100\n" + b"x" * uploads.STATEMENT_MAX_BYTES
    r = await client.post("/api/imports/ofx/preview", data={"account_id": str(world["account"])},
                          files=_f("big.qfx", big))
    assert r.status_code == 413 and "under 10 MB" in r.json()["detail"]


async def test_the_old_csv_route_is_gone():
    from fastapi.routing import iter_route_contexts

    from app.main import app as main_app
    paths = {r.path for r in iter_route_contexts(main_app.routes)}
    assert "/api/imports/csv" in paths  # the walk reaches included routers
    assert "/api/aggregator/import/csv" not in paths

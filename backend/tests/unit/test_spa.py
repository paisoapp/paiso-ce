"""The built web app served by the API (app/core/spa.py)."""
import httpx
import pytest
from fastapi import FastAPI

from app.core.spa import mount_spa

pytestmark = pytest.mark.unit


@pytest.fixture
def client(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "favicon.png").write_bytes(b"png")
    (tmp_path / "assets" / "index-abc.js").write_text("js")
    (tmp_path.parent / "secret.txt").write_text("secret")
    app = FastAPI()

    @app.get("/api/info")
    async def info():
        return {"ok": True}

    mount_spa(app, str(tmp_path))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")


async def test_routes_of_the_app_get_the_index_uncached(client):
    for path in ("/", "/transactions/all"):
        r = await client.get(path)
        assert r.status_code == 200 and "app" in r.text
        assert r.headers["cache-control"] == "no-cache"


async def test_built_assets_are_immutable_and_a_missing_one_is_not_cached(client):
    r = await client.get("/assets/index-abc.js")
    assert r.status_code == 200 and "immutable" in r.headers["cache-control"]
    r = await client.get("/assets/index-old.js")
    assert r.status_code == 404 and r.headers["cache-control"] == "no-store"


async def test_api_routes_win_and_a_missing_one_is_a_404(client):
    assert (await client.get("/api/info")).json() == {"ok": True}
    assert (await client.get("/api/nope")).status_code == 404


async def test_files_outside_the_build_are_never_served(client):
    r = await client.get("/favicon.png")
    assert r.content == b"png"
    for path in ("/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt"):
        r = await client.get(path)
        assert "secret" not in r.text


def test_nothing_is_mounted_without_a_build(tmp_path):
    app = FastAPI()
    mount_spa(app, str(tmp_path / "missing"))
    assert not [r for r in app.routes if getattr(r, "path", "") == "/{path:path}"]

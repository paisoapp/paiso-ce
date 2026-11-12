"""The app sends nosniff itself, with or without Caddy in front."""
import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import FileResponse, Response, StreamingResponse

from app.core.security_headers import SecurityHeadersMiddleware

pytestmark = pytest.mark.unit


def _app(tmp_path) -> FastAPI:
    app = FastAPI()
    app.add_middleware(SecurityHeadersMiddleware)
    receipt = tmp_path / "receipt.html"
    receipt.write_text("<script>alert(1)</script>")

    @app.get("/json")
    async def json_route():
        return {"ok": True}

    @app.get("/file")
    async def file_route():
        return FileResponse(receipt, media_type="text/html")

    @app.get("/stream")
    async def stream_route():
        return StreamingResponse(iter([b"a", b"b"]), media_type="text/plain")

    @app.get("/own")
    async def own_header():
        return Response("x", headers={"X-Content-Type-Options": "nosniff"})

    return app


async def _get(app: FastAPI, path: str) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get(path)


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/json", "/file", "/stream"])
async def test_every_response_is_nosniff(tmp_path, path):
    resp = await _get(_app(tmp_path), path)
    assert resp.status_code == 200
    assert resp.headers["x-content-type-options"] == "nosniff"


@pytest.mark.asyncio
async def test_a_route_header_is_not_doubled(tmp_path):
    resp = await _get(_app(tmp_path), "/own")
    assert resp.headers.get_list("x-content-type-options") == ["nosniff"]


@pytest.mark.asyncio
async def test_the_real_app_carries_the_middleware():
    from app.main import app

    assert any(m.cls is SecurityHeadersMiddleware for m in app.user_middleware)

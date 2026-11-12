"""The refresh cookie is Secure over HTTPS and plain over HTTP, so a session
survives a reload on a self-hosted copy reached over plain HTTP."""
import pytest
from fastapi import Response
from starlette.requests import Request

from app.api.auth import _set_refresh_cookie

pytestmark = pytest.mark.unit


def _request(scheme: str, headers: dict[str, str] | None = None) -> Request:
    return Request({
        "type": "http", "scheme": scheme, "method": "POST", "path": "/api/auth/login",
        "server": ("192.168.1.20", 8080), "headers": [
            (k.lower().encode(), v.encode()) for k, v in (headers or {}).items()
        ],
    })


def _cookie(request: Request) -> str:
    response = Response()
    _set_refresh_cookie(response, "token", request)
    return response.headers["set-cookie"]


def test_plain_http_gets_a_cookie_the_browser_will_keep():
    cookie = _cookie(_request("http"))
    assert "secure" not in cookie.lower()
    assert "httponly" in cookie.lower() and "samesite=strict" in cookie.lower()


@pytest.mark.parametrize("request_", [
    _request("https"),
    _request("http", {"X-Forwarded-Proto": "https"}),
])
def test_https_and_an_https_proxy_get_a_secure_cookie(request_):
    assert "secure" in _cookie(request_).lower()

"""The container smoke suite: a running Paiso, from the outside.

Runs against a container started on an empty data volume:

    PAISO_URL=http://127.0.0.1:8080 PAISO_CONTAINER=paiso \\
        python -m pytest tests/smoke

``scripts/smoke.sh`` at the repository root builds the image, starts it and
runs this. The tests run in order and share one account: each step builds on
the one before, as a new owner's first session would. Without ``PAISO_URL``
the whole module is skipped, so ``make test-unit`` never needs a container.
"""
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx
import pyotp
import pytest

URL = os.environ.get("PAISO_URL", "").rstrip("/")
CONTAINER = os.environ.get("PAISO_CONTAINER", "paiso-ce")
FIXTURES = Path(__file__).resolve().parents[1] / "aggregator" / "fixtures"

EMAIL = "owner@example.com"
PASSWORD = "smoke-test-pass-41"
NEW_PASSWORD = "smoke-test-pass-42"

pytestmark = [
    pytest.mark.smoke,
    pytest.mark.skipif(not URL, reason="PAISO_URL is not set: no container to test"),
]

#: Shared by the steps below, in order.
state: dict = {}


@pytest.fixture(scope="module")
def api():
    with httpx.Client(base_url=URL, timeout=30.0) as client:
        yield client


def _auth() -> dict:
    return {"Authorization": f"Bearer {state['token']}"}


def _login(api, password=PASSWORD, code=None) -> httpx.Response:
    body = {"email": EMAIL, "password": password}
    if code:
        body["totp_code"] = code
    return api.post("/api/auth/login", json=body)


def _exec(*args: str, stdin: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "python", "-m", "app.cli", *args],
        input=stdin, capture_output=True, text=True, timeout=60,
    )


def _wait_healthy(api, seconds: int = 90) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if api.get("/readyz").status_code == 200:
                return
        except httpx.TransportError:
            pass
        time.sleep(1)
    raise AssertionError("the container did not become ready")


def test_a_fresh_install_serves_the_app_and_offers_sign_up(api):
    assert api.get("/healthz").status_code == 200
    ready = api.get("/readyz")
    assert ready.status_code == 200 and ready.json()["status"] == "ok"
    assert api.get("/api/info").json()["signup_open"] is True
    page = api.get("/")
    assert page.status_code == 200 and "<div id=\"root\">" in page.text
    assert "default-src 'self'" in page.headers["content-security-policy"]
    assert api.get("/api/docs").status_code == 404  # the API docs are off in a release image


def test_the_first_sign_up_is_the_only_one(api):
    r = api.post("/api/auth/register", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 201
    state["token"] = r.json()["access_token"]
    again = api.post("/api/auth/register", json={"email": "other@example.com", "password": PASSWORD})
    assert again.status_code == 403
    assert api.get("/api/info").json()["signup_open"] is False


def test_two_factor_sign_in(api):
    uri = api.post("/api/auth/totp/enroll", headers=_auth()).json()["provisioning_uri"]
    secret = parse_qs(urlparse(uri).query)["secret"][0]
    totp = pyotp.TOTP(secret)
    # Each code works once, so enrolment takes the previous step's code (still
    # accepted) and sign-in below takes the current one.
    r = api.post("/api/auth/totp/verify", headers=_auth(),
                 json={"code": totp.at(time.time() - 30)})
    assert r.status_code == 200 and len(r.json()["backup_codes"]) > 0
    # Setting it up again while it is on is refused.
    assert api.post("/api/auth/totp/enroll", headers=_auth()).status_code == 409

    assert _login(api).status_code == 401  # the password alone asks for the code
    r = _login(api, code=totp.now())
    assert r.status_code == 200
    state["token"] = r.json()["access_token"]


def test_accounts_and_imports(api):
    def account(name, kind):
        r = api.post("/api/accounts", headers=_auth(),
                     json={"display_name": name, "account_type": kind})
        assert r.status_code in (200, 201), r.text
        return r.json()["id"]

    checking = account("Checking", "checking")
    brokerage = account("Brokerage", "brokerage")

    with open(FIXTURES / "chase_sample.csv", "rb") as f:
        r = api.post("/api/imports/bank-csv", headers=_auth(),
                     files={"file": ("chase.csv", f, "text/csv")},
                     data={"account_id": str(checking)})
    assert r.status_code == 200, r.text
    assert r.json()["imported"] > 0

    for name, acct in (("synthetic_checking_sgml.qfx", checking), ("synthetic_brokerage_seclist.ofx", brokerage)):
        with open(FIXTURES / name, "rb") as f:
            r = api.post("/api/imports/ofx", headers=_auth(),
                         files={"file": (name, f, "application/octet-stream")},
                         data={"account_id": str(acct)})
        assert r.status_code == 200, (name, r.text)

    txns = api.get("/api/transactions", headers=_auth()).json()
    assert txns["total"] > 0
    state["transactions"] = txns["total"]

    # The brokerage statement's positions became holdings, named from its SECLIST.
    held = api.get("/api/holdings", headers=_auth()).json()
    assert {h["ticker"] for h in held if h.get("kind") == "holding"} >= {"VTI", "VTSAX"}


@pytest.mark.parametrize("path", [
    "/api/dashboard",
    "/api/portfolio/summary",
    "/api/portfolio/breakdown",
    "/api/portfolio/net-worth-trend",
    "/api/budget/cashflow",
    "/api/budget/expenses",
    "/api/budget/income",
    "/api/transactions",
    "/api/holdings",
    "/api/investments/overview",
    "/api/categories",
    "/api/auth/sessions",
])
def test_the_main_pages_load(api, path):
    r = api.get(path, headers=_auth())
    assert r.status_code == 200, (path, r.status_code, r.text[:200])


def test_an_oversized_upload_is_refused_before_sign_in(api):
    r = api.post("/api/imports/csv", content=b"x" * (31 * 1024 * 1024),
                 headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413


def test_the_cli_resets_two_factor_and_the_password(api):
    out = _exec("reset-mfa", EMAIL)
    assert out.returncode == 0, out.stderr
    assert _login(api).status_code == 200  # no code needed any more

    out = _exec("reset-password", EMAIL, stdin=NEW_PASSWORD + "\n")
    assert out.returncode == 0, out.stderr
    assert _login(api).status_code == 401
    r = _login(api, password=NEW_PASSWORD)
    assert r.status_code == 200
    state["token"] = r.json()["access_token"]

    unknown = _exec("reset-password", "nobody@example.com", stdin=NEW_PASSWORD + "\n")
    assert unknown.returncode != 0


def test_data_and_sessions_survive_a_restart(api):
    subprocess.run(["docker", "restart", CONTAINER], check=True, capture_output=True, timeout=120)
    _wait_healthy(api)
    # The session still works: the secrets came back from the data volume.
    txns = api.get("/api/transactions", headers=_auth())
    assert txns.status_code == 200
    assert txns.json()["total"] == state["transactions"]
    assert _login(api, password=NEW_PASSWORD).status_code == 200
    secrets = subprocess.run(
        ["docker", "exec", CONTAINER, "stat", "-c", "%a %U", "/data/secrets/jwt_secret"],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip()
    assert re.fullmatch(r"600 paiso", secrets), secrets

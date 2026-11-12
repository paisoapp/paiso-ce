"""Sessions survive the move from python-jose to PyJWT.

The two tokens below were minted by python-jose 3.3.0 with the default test
secret ("change-me") and an expiry in 2099, before the library was swapped.
If PyJWT read them differently, every signed-in user would be signed out by
the deploy.
"""
import time

import jwt
import pytest

from app.core.config import settings
from app.core.security import create_access_token, create_refresh_token, decode_token

pytestmark = pytest.mark.unit

JOSE_ACCESS = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI0MiIsImV4cCI6NDA3MDkwODgwMCwidHlwZSI6ImFjY2VzcyIsImZhbSI6ImZhbTAiLCJzY29wZSI6ImFwcCJ9."
    "WDe9c_bQQsyr0vRseJrJJVkoOb0NPnqVrEVVp1aRiUw"
)
JOSE_REFRESH = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJzdWIiOiI0MiIsImV4cCI6NDA3MDkwODgwMCwidHlwZSI6InJlZnJlc2giLCJmYW1pbHkiOiJkZXYxIiwianRpIjoiMDAxMTIyMzM0NDU1NjY3NyIsImVwb2NoIjoiZmFtMCJ9."
    "Sj3Y5FWpdBvAaQFZOa7eTdpt4iHu3Vc2cdckp8qwaKI"
)


@pytest.fixture(autouse=True)
def _test_secret(monkeypatch):
    monkeypatch.setattr(settings, "jwt_secret", "change-me")


def test_a_jose_access_token_still_decodes():
    claims = decode_token(JOSE_ACCESS)
    assert claims == {"sub": "42", "exp": 4070908800, "type": "access",
                      "fam": "fam0", "scope": "app"}


def test_a_jose_refresh_token_still_decodes():
    claims = decode_token(JOSE_REFRESH)
    assert claims["type"] == "refresh" and claims["family"] == "dev1"
    assert claims["epoch"] == "fam0"


def test_new_tokens_round_trip():
    assert decode_token(create_access_token(7, "famX"))["fam"] == "famX"
    assert decode_token(create_refresh_token(7, "dev2", epoch="famX"))["family"] == "dev2"


def test_an_expired_token_is_refused():
    token = jwt.encode({"sub": "1", "exp": int(time.time()) - 5}, "change-me", algorithm="HS256")
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_token(token)


def test_a_token_signed_with_another_secret_is_refused():
    token = jwt.encode({"sub": "1", "exp": int(time.time()) + 60}, "another-secret", algorithm="HS256")
    with pytest.raises(jwt.InvalidSignatureError):
        decode_token(token)

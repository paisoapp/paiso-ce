"""The public /api/info carries only what the app needs before sign-in."""
import pytest

from app.api import info

pytestmark = pytest.mark.unit


class _Db:
    def __init__(self, user_id):
        self.user_id = user_id

    async def scalar(self, _stmt):
        return self.user_id


async def test_public_info_is_minimal():
    out = await info.get_info(db=_Db(None))
    assert set(out) == {"version", "version_string", "channel", "signup_open"}
    assert out["signup_open"] is True
    assert "PAISO_" not in repr(out)


async def test_public_info_says_when_sign_up_is_closed():
    assert (await info.get_info(db=_Db(1)))["signup_open"] is False

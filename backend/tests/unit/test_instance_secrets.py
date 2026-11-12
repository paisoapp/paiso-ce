"""Secrets generated on first run (app/core/instance_secrets.py)."""
import stat
from types import SimpleNamespace

import pytest

from app.core.instance_secrets import ensure_secrets, is_unset

pytestmark = pytest.mark.unit


def _settings(root, **kw):
    return SimpleNamespace(storage_root=str(root), jwt_secret=kw.get("jwt", "change-me"),
                           master_key=kw.get("key", ""))


def test_first_run_writes_private_secrets_and_later_runs_read_them(tmp_path):
    first = _settings(tmp_path)
    ensure_secrets(first)
    assert len(first.jwt_secret) == 64 and len(first.master_key) == 64
    assert first.jwt_secret != first.master_key
    secrets_dir = tmp_path / "secrets"
    assert stat.S_IMODE(secrets_dir.stat().st_mode) == 0o700
    for name in ("jwt_secret", "master_key"):
        assert stat.S_IMODE((secrets_dir / name).stat().st_mode) == 0o600

    again = _settings(tmp_path)
    ensure_secrets(again)
    assert (again.jwt_secret, again.master_key) == (first.jwt_secret, first.master_key)


def test_the_environment_wins(tmp_path):
    s = _settings(tmp_path, jwt="from-env", key="key-from-env")
    ensure_secrets(s)
    assert (s.jwt_secret, s.master_key) == ("from-env", "key-from-env")
    assert not (tmp_path / "secrets").exists()


def test_nothing_is_written_without_a_data_volume(tmp_path):
    s = _settings(tmp_path / "missing")
    ensure_secrets(s)
    assert s.jwt_secret == "change-me" and s.master_key == ""


def test_placeholders_count_as_unset():
    assert is_unset("") and is_unset("change-me")
    assert is_unset("changeme-generate-a-32-byte-hex-secret")
    assert not is_unset("0" * 64)

"""requirements.lock must match requirements.txt.

The image installs only from the lock. A Dependabot update edits
requirements.txt alone, so without this check the update would merge and the
image would keep installing the old version.
"""
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

BACKEND = Path(__file__).resolve().parents[2]
_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$")


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def _requirements() -> dict[str, str]:
    out = {}
    for line in (BACKEND / "requirements.txt").read_text().splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = _NAME.match(line)
        assert m, line
        out[_norm(m.group(1))] = m.group(3).split(";")[0].strip()
    return out


def _locked() -> dict[str, str]:
    out = {}
    for line in (BACKEND / "requirements.lock").read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?==([^\s;\\]+)", line)
        if m:
            out[_norm(m.group(1))] = m.group(3)
    return out


def test_every_requirement_is_locked_at_its_pinned_version():
    locked = _locked()
    for name, spec in _requirements().items():
        assert name in locked, f"{name} is missing from requirements.lock"
        if spec.startswith("=="):
            assert locked[name] == spec[2:], (
                f"{name}: requirements.txt pins {spec[2:]}, the lock has {locked[name]}. "
                "Regenerate requirements.lock (see backend/README.md)."
            )


def test_every_locked_package_has_a_hash():
    text = (BACKEND / "requirements.lock").read_text()
    blocks = re.split(r"\n(?=[A-Za-z0-9])", text)
    for block in blocks:
        if re.match(r"^[A-Za-z0-9].*==", block):
            assert "--hash=sha256:" in block, block.splitlines()[0]

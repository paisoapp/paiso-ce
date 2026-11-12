"""Secrets generated on first run.

No secret ships with the image. When ``PAISO_JWT_SECRET`` or ``PAISO_MASTER_KEY`` is
not set (``is_unset``), the first start writes a random one to ``<storage root>/secrets/``
(the data volume) with mode 600, and every later start reads it back. Deleting
the volume starts over with new secrets, as it starts over with no account.

``jwt_secret`` signs sign-in tokens; ``master_key`` encrypts two-factor secrets
at rest (``core/security.py``). A value set in the environment always wins.

Nothing is written when the storage root does not exist or is not writable (a
development run or a unit test); the defaults then stand, and startup warns.
"""
import os
import secrets
from pathlib import Path

_SECRETS = ("jwt_secret", "master_key")


def is_unset(value: str) -> bool:
    """True for an empty secret, the ``config.py`` default, or a placeholder
    copied from ``.env.example`` ("changeme-...")."""
    return not value or value == "change-me" or value.startswith("changeme")


def _read_or_create(path: Path) -> str:
    if path.is_file():
        return path.read_text().strip()
    value = secrets.token_hex(32)
    # O_EXCL: never overwrite a secret another start already wrote.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value + "\n")
    return value


def ensure_secrets(settings) -> None:
    """Fill in any secret the environment left unset."""
    missing = [name for name in _SECRETS if is_unset(getattr(settings, name))]
    if not missing:
        return
    root = Path(settings.storage_root)
    if not root.is_dir() or not os.access(root, os.W_OK):
        return
    directory = root / "secrets"
    directory.mkdir(mode=0o700, exist_ok=True)
    for name in missing:
        setattr(settings, name, _read_or_create(directory / name))

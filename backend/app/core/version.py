"""Resolve this build's version identity from injected build metadata.

The raw values come from ``settings``, which the Docker build sets from its
build arguments. ``version_string`` appends the short commit:

    0.1.0-a1b2c3d   (a release image)
    0.0.0-dev       (a local build, nothing stamped)
"""
from app.core.config import settings


def version_string() -> str:
    base = settings.app_version
    if settings.git_commit:
        base = f"{base}-{settings.git_commit}"
    return base


def build_info() -> dict:
    """Flat build-identity payload shared by /api/info and startup recording."""
    return {
        "version": settings.app_version,
        "version_string": version_string(),
        "channel": settings.release_channel,
        "commit": settings.git_commit or None,
        "build_time": settings.build_time or None,
    }

"""Serving the built web app from the API process.

The image copies the frontend build (``frontend/dist``) to ``PAISO_STATIC_DIR``.
``/assets`` holds content-hashed files, cached for a year; every other path
that is not an API route answers with the file of that name in the build, or
``index.html`` so the app's own router can take it. ``index.html`` is never
cached, so an upgrade is picked up on the next load.

When the directory does not exist (a development API run beside the Vite
server), nothing is mounted.
"""
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import Scope

#: Paths the API owns. A missing one is a 404, never the app's index page.
_API_PREFIXES = ("api/", "healthz", "readyz")


class _Assets(StaticFiles):
    """Hashed build assets: immutable once they exist, never cached when not."""

    async def get_response(self, path: str, scope: Scope):
        # A tab that outlived an upgrade asks for the previous build's files;
        # that 404 must not be cached, or the file name could come back later.
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            return Response(status_code=exc.status_code, headers={"Cache-Control": "no-store"})
        if response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-store"
        return response


def mount_spa(app: FastAPI, static_dir: str) -> None:
    root = Path(static_dir)
    index = root / "index.html"
    if not index.is_file():
        return
    root = root.resolve()

    if (root / "assets").is_dir():
        app.mount("/assets", _Assets(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(_API_PREFIXES):
            raise HTTPException(status_code=404)
        candidate = (root / path).resolve()
        if path and candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate, headers={"Cache-Control": "no-cache"})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # extra="ignore": unknown PAISO_* entries in a shared .env (e.g. flags only a
    # feature branch defines) must not crash the server on other branches.
    model_config = SettingsConfigDict(env_prefix="PAISO_", env_file=".env", extra="ignore")

    # Database: one SQLite file.
    sqlite_path: str = "/data/paiso.db"

    # Run the scheduled jobs (market data, transfer pairing) in this process.
    # PAISO_SCHEDULER=false turns them off, for a second process or for tests.
    scheduler: bool = True

    # Where uploads, generated secrets and the database live: the data volume.
    storage_root: str = "/data"
    # Where the image keeps the built web app. Served when it exists.
    static_dir: str = "/app/static"

    # Security
    master_key: str = ""
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    # Short-lived access tokens; the frontend silently refreshes via the
    # paiso_refresh cookie (per-device rotating refresh sessions).
    jwt_access_expire_minutes: int = 60
    jwt_refresh_expire_days: int = 30

    # Header the edge proxy sets to the visitor's real address, used to key
    # per-client rate limits. "CF-Connecting-IP" behind Cloudflare (the
    # cloudflare compose overlay sets it). Leave empty when nothing in front
    # of the app overwrites the header: a client could otherwise forge it.
    trusted_ip_header: str = ""

    # CORS. Empty: the image serves the web app from the API's own origin, and
    # the development server passes /api through, so no other origin needs it.
    allowed_origins: list[str] = []

    # Ops
    auto_migrate: bool = True

    # Build identity (injected at image build time via Docker ARG → ENV).
    # Defaults describe a local, un-stamped dev build.
    app_version: str = "0.0.0-dev"
    release_channel: str = "dev"  # "prod" in a release image, "dev" otherwise
    git_commit: str = ""
    build_time: str = ""

    @property
    def database_url(self) -> str:
        return f"sqlite+aiosqlite:///{self.sqlite_path}"

    @property
    def sync_database_url(self) -> str:
        return f"sqlite:///{self.sqlite_path}"


settings = Settings()

# Secrets the environment left unset come from the data volume (first run
# writes them there): see app/core/instance_secrets.py.
from app.core.instance_secrets import ensure_secrets  # noqa: E402

ensure_secrets(settings)

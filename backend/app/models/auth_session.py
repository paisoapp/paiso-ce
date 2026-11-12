"""Per-device refresh sessions."""
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RefreshToken(Base):
    """One row per device session. The refresh JWT carries this row's `family`;
    each redemption rotates `token_hash`, so a replayed (stolen) old token is
    detected as a hash mismatch and revokes the whole session. Global
    revocation stays on user.token_family (the access-token epoch)."""
    __tablename__ = "refresh_token"
    __table_args__ = (Index("idx_refresh_token_user", "user_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    family: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False)  # sha256 of the JWT
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # The browser's User-Agent at sign-in, cut to 255 characters, so the
    # Security tab can say "Chrome on macOS" instead of "Another device".
    user_agent: Mapped[str | None] = mapped_column(String(255), nullable=True)

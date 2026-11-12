from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class User(Base):
    __tablename__ = "user"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    # Every account has one; the column allows NULL only because sign-in
    # treats a missing hash as a wrong password (see auth.py, login).
    hashed_password: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Always "user": an install has one account.
    role: Mapped[str] = mapped_column(String(16), default="user")

    # Profile
    first_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    dob: Mapped[date | None] = mapped_column(Date, nullable=True)
    phone: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # Avatar stored inline as a base64 data-URI (e.g. "data:image/png;base64,...")
    # so it can be rendered in an <img> across the app without a separate
    # authenticated fetch. Kept small via client-side downscaling + a server cap.
    avatar: Mapped[str | None] = mapped_column(Text, nullable=True)

    # TOTP 2FA
    # Text, not String(64): stored Fernet-encrypted ("enc:<token>", ~140 chars).
    totp_secret: Mapped[str | None] = mapped_column(Text, nullable=True)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # Brute-force protection
    # Stays NULL: this edition sends no email, so nothing verifies an address.
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Admin-driven enforcement flags
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    mfa_required: Mapped[bool] = mapped_column(Boolean, default=False)


    # Refresh token family (rotated on password change)
    token_family: Mapped[str] = mapped_column(String(64), default="")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    accounts: Mapped[list] = relationship("Account", back_populates="user", cascade="all, delete-orphan")
    assets: Mapped[list] = relationship("Asset", back_populates="user", cascade="all, delete-orphan")
    settings: Mapped["UserSettings | None"] = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserBackupCode(Base):
    """One single-use recovery code, standing in for a TOTP code at login.

    Without these, losing an authenticator is a hard lockout: /totp/disable
    needs a live session, and a session needs the code you no longer have. An
    admin can now clear someone's enrolment, but that requires an admin to be
    available and willing — recovery codes let the account holder get back in
    on their own.

    Stored as a SHA-256 hash, matching how reset tokens are kept. These are
    high-entropy random strings rather than user-chosen passwords, so a fast
    hash is the right call here: a slow one would have login verify up to ten
    Argon2 hashes on every attempt for no gain against a 60-bit secret.

    A code is spent by setting `used_at` rather than deleting the row, so the
    account page can show how many remain and a support conversation can tell
    "never generated" from "all ten burned".
    """
    __tablename__ = "user_backup_code"
    __table_args__ = (
        Index("idx_backup_code_user", "user_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

ACCOUNT_TYPES = (
    "checking", "savings", "credit_card", "brokerage",
    "hsa", "529", "401k", "ira", "roth_ira", "loan", "mortgage", "other",
)


class Institution(Base):
    __tablename__ = "institution"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    # `Mapped[list]` without its element type is not a collection to SQLAlchemy:
    # it cannot read an element out of a bare `list`, so it fell back to
    # `uselist=False` and treated this one-to-many as a scalar.
    #
    # That is destructive rather than cosmetic. `back_populates` assigns through
    # this attribute, so pointing a *second* account at the same institution
    # replaced the first one in a scalar slot and set its `institution_id` to
    # NULL. Renaming the institution on one of several accounts there blanked it on
    # the one renamed before it, every time.
    accounts: Mapped[list["Account"]] = relationship(
        "Account", back_populates="institution"
    )


class Account(Base):
    __tablename__ = "account"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    institution_id: Mapped[int | None] = mapped_column(ForeignKey("institution.id"), nullable=True)
    account_type: Mapped[str] = mapped_column(String(32), nullable=False)
    display_name: Mapped[str] = mapped_column(String(255), nullable=False)
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    currency: Mapped[str] = mapped_column(String(8), default="USD")
    current_balance: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    balance_as_of: Mapped[date | None] = mapped_column(Date, nullable=True)
    credit_limit: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    # deferrable: account↔asset can form a cycle (mortgage trio); backup
    # restore defers FK checks to commit (SET CONSTRAINTS ALL DEFERRED on pg).
    linked_asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("asset.id", deferrable=True), nullable=True
    )
    description_pattern: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # What the account is for (``investment_type``: investing, retirement,
    # education, health — the Investments tab it lives on) and its legal
    # structure (``subtype``, spelled as in the account schema: "403B",
    # "roth 401k"), which decides its tax treatment. See
    # app.modules.accounts.classification.
    investment_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    subtype: Mapped[str | None] = mapped_column(String(64), nullable=True)
    classification_set_by_user: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    # The part of a hand-kept plan no ticker covers, as the user last entered
    # it, and the value before that (so the page can show the change). Added
    # to the account's tickers; see valuation.tracked_account_value.
    other_funds_value: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    other_funds_as_of: Mapped[date | None] = mapped_column(Date, nullable=True)
    other_funds_prev_value: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    # What the user has put in, for a plan whose funds carry no cost basis.
    contributions_total: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    # HSA: "self" or "family" coverage, which sets the year's contribution limit.
    hsa_coverage: Mapped[str | None] = mapped_column(String(8), nullable=True)
    # An account the user lists but leaves out of every total, as an
    # excluded holding is.
    exclude_from_net_worth: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    user: Mapped["User"] = relationship("User", back_populates="accounts")
    institution: Mapped["Institution | None"] = relationship("Institution", back_populates="accounts")
    transactions: Mapped[list] = relationship("Transaction", back_populates="account", cascade="all, delete-orphan")
    holdings: Mapped[list] = relationship("Holding", back_populates="account", cascade="all, delete-orphan")
    csv_mappings: Mapped[list] = relationship("CsvMapping", back_populates="account", cascade="all, delete-orphan")


class CsvMapping(Base):
    __tablename__ = "csv_mapping"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("account.id"), nullable=False, unique=True)
    mapping_json: Mapped[str] = mapped_column(Text, nullable=False)  # JSON column map
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    account: Mapped["Account"] = relationship("Account", back_populates="csv_mappings")

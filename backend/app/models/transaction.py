from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, false as sa_false, text  # noqa: F401 – Boolean also used by Category.is_income
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class TransactionAttachment(Base):
    __tablename__ = "transaction_attachment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    transaction_id: Mapped[int] = mapped_column(
        ForeignKey("transaction.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    stored_name: Mapped[str] = mapped_column(String(255), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(128), nullable=True)
    size_bytes: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    transaction: Mapped["Transaction"] = relationship(
        "Transaction", back_populates="attachments"
    )


class Category(Base):
    __tablename__ = "category"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    # deferrable: self-referential — backup restore inserts rows in arbitrary
    # order within the table and defers FK checks to commit.
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("category.id", deferrable=True), nullable=True
    )
    is_income: Mapped[bool] = mapped_column(Boolean, default=False)
    # Budgeting treatment: how this category's transactions are classified.
    #   "income"   → counted as income
    #   "expense"  → counted as expense
    #   "transfer" → net-worth-neutral (buys/sells, payments, reimbursements);
    #                excluded from income/expense totals.
    treatment: Mapped[str | None] = mapped_column(String(16), nullable=True)
    color: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # An emoji; older rows held an icon name such as "circle".
    icon: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # A top-level group (Income, Expense, Transfer, or one the user made) that
    # holds categories, rather than a category itself.
    is_group: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=sa_false())
    # Order inside its group, set by dragging in Settings → Categories.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")

    parent: Mapped["Category | None"] = relationship("Category", remote_side="Category.id")
    transactions: Mapped[list] = relationship("Transaction", back_populates="category")

    __table_args__ = (
        Index("idx_category_user_id", "user_id"),
        Index("idx_category_is_income", "user_id", "is_income"),
    )


class Transaction(Base):
    __tablename__ = "transaction"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("account.id"), nullable=False)
    date_posted: Mapped[date] = mapped_column(Date, nullable=False)
    transaction_type: Mapped[str | None] = mapped_column(String(16), nullable=True)  # credit|debit
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    amount: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    balance: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    category_id: Mapped[int | None] = mapped_column(ForeignKey("category.id"), nullable=True)
    tags: Mapped[str | None] = mapped_column(Text, nullable=True)  # comma-separated
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    member_name: Mapped[str | None] = mapped_column(String(128), nullable=True)  # card member (e.g. Citibank CC)
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)  # aggregator|csv|manual
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_duplicate: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    is_split: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")

    # ── Unsettled transactions ───────────────────────────────────────────────
    # Shown in the ledger so it matches the bank's own app, but excluded from
    # budgets and net worth: pending amounts are frequently wrong (fuel holds,
    # restaurant tips settle at a different value).
    pending: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    # ── Enrichment (from the import; never overwrites `description`) ──
    # `description` stays the user-editable field; merchant_name is the
    # normalised counterparty and is a far better key for the categorizer's
    # history stage than a raw statement string.
    merchant_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Authorisation date, distinct from posting date — a purchase can authorise
    # in one month and post in the next. OFX carries the same distinction
    # (DTUSER vs DTPOSTED) and it was previously discarded.
    date_authorized: Mapped[date | None] = mapped_column(Date, nullable=True)

    # How category_id was set: auto (heuristics or history), rule (a user
    # CategoryRule), or user (chosen by hand). Nothing automatic may overwrite
    # a `user` categorisation.
    category_source: Mapped[str | None] = mapped_column(String(8), nullable=True)

    # The bank's own category label from the imported file ("Groceries",
    # "Food & Drink"), kept so a later change to the categorizer's bank map
    # can recategorize old rows.
    bank_category: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    account: Mapped["Account"] = relationship("Account", back_populates="transactions")
    category: Mapped["Category | None"] = relationship("Category", back_populates="transactions")
    attachments: Mapped[list["TransactionAttachment"]] = relationship(
        "TransactionAttachment", back_populates="transaction", cascade="all, delete-orphan"
    )

    __table_args__ = (
        Index("idx_txn_account_date", "account_id", "date_posted"),
        Index("idx_txn_category", "category_id"),
        Index("idx_txn_amount_date", "account_id", "date_posted", "amount"),
        # Every import path already treats (account_id, external_id) as the
        # dedupe key, but only advisorily — via a per-row SELECT, which is both
        # N+1 and racy: two concurrent syncs could double-insert. Making it a
        # real constraint lets all three paths use ON CONFLICT instead.
        # Partial, because manually entered rows legitimately have no
        # external_id and NULLs must not collide.
        Index(
            "uq_txn_account_external",
            "account_id",
            "external_id",
            unique=True,
            sqlite_where=text("external_id IS NOT NULL"),
        ),
        Index("idx_txn_pending", "account_id", "pending"),
    )

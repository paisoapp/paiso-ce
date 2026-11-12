"""Pairing of the two legs of a single money movement.

A credit-card payment, a savings sweep or a mortgage payment appears twice in
the ledger — once leaving one account, once arriving in another. Paiso already
keeps those net-worth-neutral through ``Category.treatment == "transfer"``,
and **this table does not change that**. What it adds is the link itself:

* the Transfers tab reports one $500 card payment as $500 in *and* $500 out,
  because it has no way to know the two rows are the same movement;
* provenance — "paid from Chase Checking" — is not recoverable today;
* in the mixed case (the two legs imported from different files) one leg
  lands in a transfer category and the other does not, so the payment is
  counted once as a real expense;
* matching a mortgage payment to the liability's ``last_payment_amount``
  needs somewhere to record the match.

The two partial unique indexes are the load-bearing part: they enforce **at
the database level** that a transaction participates in at most one live link,
which is what makes double-booking structurally impossible rather than merely
unlikely. Rejected rows are kept as tombstones so the matcher never
re-suggests a pair the user has already dismissed, while leaving both legs
free to pair with something else.
"""
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

#: What kind of movement the pair represents. Drives the label in the UI and
#: which category the legs are nudged into on confirmation.
TRANSFER_KINDS = (
    "credit_card_payment",
    "loan_payment",
    "account_transfer",
    "investment_contribution",
)

#: suggested → shown for review; confirmed → treated as a real pair;
#: rejected → tombstone, never re-suggested.
TRANSFER_STATUSES = ("suggested", "confirmed", "rejected")


class TransferLink(Base):
    __tablename__ = "transfer_link"
    __table_args__ = (
        # "A transaction is in at most one *live* link." Partial, so a rejected
        # tombstone does not hold the slot against a better match later.
        Index(
            "uq_transfer_outflow",
            "outflow_txn_id",
            unique=True,
            sqlite_where=text("status <> 'rejected'"),
        ),
        Index(
            "uq_transfer_inflow",
            "inflow_txn_id",
            unique=True,
            sqlite_where=text("status <> 'rejected'"),
        ),
        # Keeps the tombstone unique so a dismissed pair is remembered exactly once.
        UniqueConstraint("outflow_txn_id", "inflow_txn_id", name="uq_transfer_pair"),
        Index("idx_transfer_user_status", "user_id", "status"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    outflow_txn_id: Mapped[int] = mapped_column(
        ForeignKey("transaction.id", ondelete="CASCADE"), nullable=False
    )
    inflow_txn_id: Mapped[int] = mapped_column(
        ForeignKey("transaction.id", ondelete="CASCADE"), nullable=False
    )

    #: Absolute amount, denormalised so the review list needs no join.
    amount: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    kind: Mapped[str] = mapped_column(String(24), nullable=False)
    confidence: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="suggested")
    #: auto (matcher) or manual (the user paired them by hand).
    source: Mapped[str] = mapped_column(String(8), nullable=False, default="auto")
    #: Which signals fired, e.g. "amount+1d+pfc". Kept because a scoring bug is
    #: otherwise invisible after the fact.
    matched_on: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    confirmed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

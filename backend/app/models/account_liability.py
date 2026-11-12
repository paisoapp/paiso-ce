"""Liability detail for a credit card, loan or mortgage account.

A separate 1:1 table rather than a dozen nullable columns on ``account``:
``account`` is the hottest table in the app and is joined by nearly every
query, and most accounts are not liabilities.

Every field here is entered by hand.

Rates are stored as **percents** (6.5 means 6.5%), matching this app's
``Loan.rate_apr``, so no conversion happens anywhere along the path.
"""
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

#: Which shape of liability this is.
LIABILITY_KINDS = ("credit", "student", "mortgage", "auto", "personal")


class AccountLiability(Base):
    __tablename__ = "account_liability"

    account_id: Mapped[int] = mapped_column(
        ForeignKey("account.id", ondelete="CASCADE"), primary_key=True
    )
    kind: Mapped[str | None] = mapped_column(String(16), nullable=True)

    # ── Rate ─────────────────────────────────────────────────────────────────
    apr_pct: Mapped[float | None] = mapped_column(Numeric(9, 5), nullable=True)
    apr_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    #: Credit cards carry several APRs (purchase, cash advance, balance
    #: transfer, penalty). The headline one is apr_pct; the rest are kept
    #: verbatim rather than discarded.
    aprs_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    # ── Payments ─────────────────────────────────────────────────────────────
    minimum_payment: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    next_payment_due_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    next_monthly_payment: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    #: Drives the transfer matcher's loan-payment boost: a bank transaction of
    #: exactly this amount around this date is almost certainly this payment.
    last_payment_amount: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    last_payment_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    is_overdue: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    past_due_amount: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)

    # ── Statement ────────────────────────────────────────────────────────────
    last_statement_balance: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    last_statement_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # ── Origination / term ───────────────────────────────────────────────────
    origination_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    origination_principal: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    maturity_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    expected_payoff_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    term_months: Mapped[int | None] = mapped_column(Integer, nullable=True)
    loan_name: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # ── Mortgage extras ──────────────────────────────────────────────────────
    escrow_balance: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    ytd_interest_paid: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    ytd_principal_paid: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    has_pmi: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_prepayment_penalty: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    property_address_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

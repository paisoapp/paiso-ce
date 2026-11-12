"""Models for the monthly budgeting feature (Performance tab).

A user can keep several ``Budget`` rows (profiles) and exactly one of them is
active: the one the Performance tab grades spending against.  The others are
kept so a different split can be tried without overwriting the first.  Each has
many ``BudgetLine`` rows — one per category it allocates money to.

A line's amount can change over time.  Each change is a ``BudgetLineAmount``
row holding the month it applies from, so a past month keeps the amount it had.
``amount_for`` in ``app/modules/budgeting/plan.py`` reads them.
Monthly rollover is still computed on the fly from transaction history (the
sum of each month's amount, minus actual spending, since the line's
``rollover_from``, or ``start_month`` when that is empty).
"""
from datetime import date, datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint, false as sa_false, text, true as sa_true
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Budget(Base):
    """A budget profile.  One per user is active at a time."""
    __tablename__ = "budget"
    __table_args__ = (
        Index("idx_budget_user", "user_id"),
        # The database, not the API, is what guarantees a single active budget.
        Index(
            "uq_budget_one_active", "user_id", unique=True, sqlite_where=text("is_active"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(60), nullable=False, default="My budget", server_default="My budget")
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=sa_true())
    # Monthly spending target.  NULL ⇒ derived from trailing income (income_basis="auto").
    total_target: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    # "manual" — user typed a total; "auto" — use trailing-average income.
    income_basis: Mapped[str] = mapped_column(String(8), nullable=False, default="manual")
    # How many months of history feed the recommendation engine.
    trailing_months: Mapped[int] = mapped_column(Integer, nullable=False, default=3)
    # First day of the month the user enrolled — the rollover accrual origin.
    start_month: Mapped[date] = mapped_column(Date, nullable=False)
    # Whether a category added to this budget starts with rollover on.
    rollover_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=sa_false())
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    lines: Mapped[list["BudgetLine"]] = relationship(
        "BudgetLine",
        back_populates="budget",
        cascade="all, delete-orphan",
        order_by="BudgetLine.id",
    )


class BudgetLine(Base):
    """A per-category monthly allocation that rolls up into a Needs/Wants/Savings bucket."""
    __tablename__ = "budget_line"
    __table_args__ = (
        UniqueConstraint("budget_id", "category_id", name="uq_budget_line_budget_category"),
        Index("idx_budget_line_budget", "budget_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    budget_id: Mapped[int] = mapped_column(
        ForeignKey("budget.id", ondelete="CASCADE"), nullable=False
    )
    category_id: Mapped[int] = mapped_column(
        ForeignKey("category.id", ondelete="CASCADE"), nullable=False
    )
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    # "needs" | "wants" | "savings"
    bucket: Mapped[str] = mapped_column(String(8), nullable=False, default="needs")
    # 0/1 — when set, unspent/overspent budget accrues month-to-month.
    rollover_enabled: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # First month rollover counts for: the month it was turned on.
    # NULL counts from the budget's start_month, as lines turned on before
    # this column existed always did.
    rollover_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    # Removed from this budget by the user.  The line and its amount history
    # stay, so past months still show what was planned for them.
    hidden: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default=sa_false())
    # Order inside its bucket.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    budget: Mapped["Budget"] = relationship("Budget", back_populates="lines")


class BudgetLineAmount(Base):
    """One change to a budget line's amount.

    ``scope`` is ``onward`` (``month`` and every later month, until the next
    ``onward`` row) or ``month`` (that month only).  ``BudgetLine.amount`` is a
    cache of the amount in force this month.
    """
    __tablename__ = "budget_line_amount"
    __table_args__ = (
        UniqueConstraint("budget_line_id", "month", "scope", name="uq_budget_line_amount_line_month_scope"),
        Index("idx_budget_line_amount_line", "budget_line_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("user.id", ondelete="CASCADE"), nullable=False
    )
    budget_line_id: Mapped[int] = mapped_column(
        ForeignKey("budget_line.id", ondelete="CASCADE"), nullable=False
    )
    # First day of the month the amount applies from.
    month: Mapped[date] = mapped_column(Date, nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False, default=0)
    # "onward" | "month"
    scope: Mapped[str] = mapped_column(String(8), nullable=False, default="onward", server_default="onward")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

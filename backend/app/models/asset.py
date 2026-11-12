from datetime import date

from sqlalchemy import Date, ForeignKey, Integer, Numeric, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

ASSET_CATEGORIES = ("primary_home", "rental", "vehicle", "precious_metal", "collectible", "other")


class Asset(Base):
    __tablename__ = "asset"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), nullable=False)
    category: Mapped[str] = mapped_column(String(32), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    ownership_pct: Mapped[float] = mapped_column(Numeric(5, 2), default=100.00)
    current_value: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)
    valuation_source: Mapped[str | None] = mapped_column(String(64), nullable=True)  # zillow|redfin|manual|kbb
    valuation_external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    acquired_value: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True)
    acquired_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)  # address, vin, etc.

    user: Mapped["User"] = relationship("User", back_populates="assets")
    loan: Mapped["Loan | None"] = relationship("Loan", back_populates="asset", uselist=False, cascade="all, delete-orphan", lazy="selectin")


class Loan(Base):
    __tablename__ = "loan"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    asset_id: Mapped[int | None] = mapped_column(ForeignKey("asset.id"), nullable=True)
    principal: Mapped[float] = mapped_column(Numeric(18, 2), nullable=False)
    rate_apr: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False)
    term_months: Mapped[int] = mapped_column(Integer, nullable=False)
    origination: Mapped[date] = mapped_column(Date, nullable=False)
    extra_principal_monthly: Mapped[float] = mapped_column(Numeric(18, 2), default=0)
    insurance_monthly: Mapped[float] = mapped_column(Numeric(18, 2), default=0)
    property_tax_monthly: Mapped[float] = mapped_column(Numeric(18, 2), default=0)
    # Escrow read from the mortgage payments, used when insurance and
    # property tax are both empty. Sources: "payments" (filled in by Paiso)
    # or "user" (typed, never replaced).
    escrow_monthly: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True, default=None)
    escrow_source: Mapped[str | None] = mapped_column(String(8), nullable=True, default=None)
    extra_principal_source: Mapped[str | None] = mapped_column(String(8), nullable=True, default=None)
    # User-supplied current balance — overrides the schedule-derived balance and
    # anchors a fresh amortization projection forward from balance_override_date.
    balance_override: Mapped[float | None] = mapped_column(Numeric(18, 2), nullable=True, default=None)
    balance_override_date: Mapped[date | None] = mapped_column(Date, nullable=True, default=None)

    asset: Mapped["Asset | None"] = relationship("Asset", back_populates="loan")
    payment_schedule: Mapped[list["PaymentSchedule"]] = relationship("PaymentSchedule", back_populates="loan", cascade="all, delete-orphan", lazy="selectin", order_by="PaymentSchedule.month_number")


class PaymentSchedule(Base):
    __tablename__ = "payment_schedule"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    loan_id: Mapped[int] = mapped_column(ForeignKey("loan.id"), nullable=False)
    month_number: Mapped[int] = mapped_column(Integer, nullable=False)
    payment_date: Mapped[date] = mapped_column(Date, nullable=False)
    principal: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    interest: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)
    escrow: Mapped[float] = mapped_column(Numeric(18, 4), default=0)
    balance: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)

    loan: Mapped["Loan"] = relationship("Loan", back_populates="payment_schedule")

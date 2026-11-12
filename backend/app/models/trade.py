from datetime import date

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, Numeric, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

TRADE_ACTIONS = (
    "buy", "sell", "dividend", "reinvest", "interest", "capgain", "split",
    # A user can enter these two. `transfer` is split by direction rather than being one action
    # with a signed `shares`, because every existing consumer assumes shares
    # are positive and the action carries the direction. Breaking that
    # invariant for one action is how a position silently mis-states itself.
    "fee", "transfer_in", "transfer_out",
)

# Actions that represent cash income received from the position (Trade.amount).
# `fee` is cash *out* and deliberately excluded — it is not income, and the
# dividend/tax views sum this tuple directly.
INCOME_ACTIONS = ("dividend", "reinvest", "interest", "capgain")

# Actions that move shares into or out of a position without being a taxable
# disposal. A transfer_out consumes lots but realises nothing — treating it as
# a sale would invent a capital gain the user never had.
TRANSFER_ACTIONS = ("transfer_in", "transfer_out")


class Trade(Base):
    __tablename__ = "trade"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    holding_id: Mapped[int] = mapped_column(
        ForeignKey("holding.id", ondelete="CASCADE"), nullable=False
    )
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)  # one of TRADE_ACTIONS
    shares: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False)
    price_per_share: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    # Total cash received for income actions (dividend/reinvest/interest/capgain)
    amount: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    # Split ratio for "split" actions (2.0 = 2-for-1, 0.25 = 1-for-4)
    split_ratio: Mapped[float | None] = mapped_column(Numeric(12, 6), nullable=True)
    # Qualified-dividend flag for tax reporting (income actions only)
    is_qualified: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    # Broker transaction id (the OFX FITID) for import dedupe.
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    holding: Mapped["Holding"] = relationship("Holding", back_populates="trades")

    __table_args__ = (
        Index("idx_trade_external_id", "external_id"),
        # Scoped to the holding, not global: two brokers can legitimately issue
        # the same FITID, and a statement import skips a row on this pair.
        Index("uq_trade_holding_external", "holding_id", "external_id", unique=True,
              sqlite_where=text("external_id IS NOT NULL")),
    )

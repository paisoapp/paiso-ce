from datetime import date

from sqlalchemy import Boolean, Date, ForeignKey, Index, Integer, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

LOT_METHODS = ("fifo", "lifo", "avg", "specific")


class Holding(Base):
    __tablename__ = "holding"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("account.id"), nullable=False)
    security_id: Mapped[int] = mapped_column(ForeignKey("security.id"), nullable=False)
    shares: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    cost_basis_total: Mapped[float | None] = mapped_column(Numeric(18, 4), nullable=True)
    acquired_at: Mapped[date | None] = mapped_column(Date, nullable=True)
    lot_method: Mapped[str] = mapped_column(String(16), default="fifo")
    exclude_from_net_worth: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_favorited: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("idx_holding_account_id", "account_id"),
        Index("idx_holding_security_id", "security_id"),
        # One position per security per account, so two concurrent statement
        # imports cannot double-insert. A sold-out position is `shares = 0`, never a
        # deleted row, so its cost_basis_total and trades stay.
        UniqueConstraint("account_id", "security_id", name="uq_holding_account_security"),
    )

    account: Mapped["Account"] = relationship("Account", back_populates="holdings")
    security: Mapped["Security"] = relationship("Security", back_populates="holdings")
    trades: Mapped[list] = relationship("Trade", back_populates="holding", cascade="all, delete-orphan", order_by="Trade.trade_date")

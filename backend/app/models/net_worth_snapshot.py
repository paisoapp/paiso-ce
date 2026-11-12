from datetime import date

from sqlalchemy import Date, ForeignKey, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class NetWorthSnapshot(Base):
    __tablename__ = "net_worth_snapshot"

    user_id: Mapped[int] = mapped_column(ForeignKey("user.id"), primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, primary_key=True)
    net_worth: Mapped[float] = mapped_column(Numeric(18, 2), nullable=False)
    total_assets: Mapped[float] = mapped_column(Numeric(18, 2), nullable=False)
    total_liabilities: Mapped[float] = mapped_column(Numeric(18, 2), nullable=False)

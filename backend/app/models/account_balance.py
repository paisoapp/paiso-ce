"""What an account's balance was on a day it was observed.

``account.current_balance`` is overwritten by every import and every edit,
so on its own it says nothing about the past, and imported transactions often
carry no running balance. Without this table such an account could only be
drawn as a flat line at today's balance.

One row per account per day, the last balance seen that day. Debts are stored
as the account stores them; readers take the absolute value where they need an
amount owed.
"""
from datetime import date

from sqlalchemy import Date, ForeignKey, Numeric
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AccountBalanceSnapshot(Base):
    __tablename__ = "account_balance_snapshot"

    account_id: Mapped[int] = mapped_column(
        ForeignKey("account.id", ondelete="CASCADE"), primary_key=True
    )
    as_of: Mapped[date] = mapped_column(Date, primary_key=True)
    balance: Mapped[float] = mapped_column(Numeric(18, 4), nullable=False)

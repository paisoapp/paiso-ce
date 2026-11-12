from datetime import date, datetime

from sqlalchemy import Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base

SECURITY_TYPES = (
    "stock", "etf", "mutual_fund", "index_fund", "529_portfolio", "custom",
    "cash", "fixed_income", "target_date_fund", "crypto", "other",
)


class Security(Base):
    """Shared security reference data, keyed by whichever identifier we have.

    ``ticker`` stays globally unique — ``get_quote``, ``refresh_and_persist``,
    ``get_quotes_cached`` and ``summary.ticker_to_sec`` all key on it. The
    other identifiers get their own partial uniques so a ticker-less fund (a
    401(k) target-date fund, a cash sweep) still resolves to exactly one row.
    NULLs are distinct under a unique index on both SQLite and Postgres, so
    any number of rows may leave any given identifier empty.
    """

    __tablename__ = "security"
    __table_args__ = (
        Index("uq_security_cusip", "cusip", unique=True,
              sqlite_where=text("cusip IS NOT NULL")),
        Index("uq_security_isin", "isin", unique=True,
              sqlite_where=text("isin IS NOT NULL")),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    ticker: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    # Resolution ladder: cusip → isin → ticker → create.
    cusip: Mapped[str | None] = mapped_column(String(16), nullable=True)
    isin: Mapped[str | None] = mapped_column(String(16), nullable=True)
    custom_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # A **percent** (0.03 = 0.03%). Entered on the Add Holding form ("Expense Ratio (%)")
    # or filled from yfinance's netExpenseRatio by refresh_security_info.
    # See modules/portfolio/fees for where the units are reconciled.
    expense_ratio: Mapped[float | None] = mapped_column(Numeric(6, 4), nullable=True)
    # Last time dividend history was pulled from yfinance (naive UTC). Drives the
    # on-demand refresh cooldown; NULL until first synced.
    dividends_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    holdings: Mapped[list] = relationship("Holding", back_populates="security")
    price_history: Mapped[list] = relationship("PriceHistory", back_populates="security", cascade="all, delete-orphan")
    intraday_price_history: Mapped[list] = relationship("IntradayPriceHistory", back_populates="security", cascade="all, delete-orphan")


class PriceHistory(Base):
    __tablename__ = "price_history"

    security_id: Mapped[int] = mapped_column(ForeignKey("security.id"), primary_key=True)
    as_of: Mapped[date] = mapped_column(Date, primary_key=True)
    close: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    open: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    high: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    low: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)

    security: Mapped["Security"] = relationship("Security", back_populates="price_history")


class SecurityInfo(Base):
    """Slow-changing per-ticker metadata (sector, market cap, PE, ...).

    Typed columns for fields worth sorting/filtering holdings by; the full
    curated yfinance .info payload lives in info_json so a future ticker-detail
    page can surface more fields without a schema change. Refreshed once daily
    by the refresh_security_info worker task.
    """
    __tablename__ = "security_info"

    security_id: Mapped[int] = mapped_column(
        ForeignKey("security.id", ondelete="CASCADE"), primary_key=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sector: Mapped[str | None] = mapped_column(String(64), nullable=True)
    industry: Mapped[str | None] = mapped_column(String(128), nullable=True)
    market_cap: Mapped[float | None] = mapped_column(Numeric(20, 0), nullable=True)
    pe_ratio: Mapped[float | None] = mapped_column(Numeric(12, 4), nullable=True)
    dividend_yield: Mapped[float | None] = mapped_column(Numeric(10, 6), nullable=True)
    week52_high: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    week52_low: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)
    info_json: Mapped[str | None] = mapped_column(Text, nullable=True)


class SecurityDividend(Base):
    """Per-share dividend payments by ex-date, synced weekly from yfinance.

    Source data for dividend suggestions — actual received dividends are
    recorded as Trade rows once the user confirms them.
    """
    __tablename__ = "security_dividend"

    security_id: Mapped[int] = mapped_column(
        ForeignKey("security.id", ondelete="CASCADE"), primary_key=True
    )
    ex_date: Mapped[date] = mapped_column(Date, primary_key=True)
    amount_per_share: Mapped[float] = mapped_column(Numeric(18, 6), nullable=False)
    # Unadjusted close on the ex-date (DRIP price hint). Nullable: yfinance
    # doesn't always have a trading-day close lined up with the dividend row.
    price_hint: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)


class IntradayPriceHistory(Base):
    """Sub-daily price bars (5m, 1h) for portfolio intraday charting."""
    __tablename__ = "intraday_price_history"

    security_id: Mapped[int] = mapped_column(ForeignKey("security.id"), primary_key=True)
    # Stored as naive UTC datetime
    ts: Mapped[datetime] = mapped_column(DateTime, primary_key=True)
    interval: Mapped[str] = mapped_column(String(8), primary_key=True)  # "1m" | "1h"
    close: Mapped[float | None] = mapped_column(Numeric(18, 6), nullable=True)

    __table_args__ = (
        Index("idx_intraday_sec_interval_ts", "security_id", "interval", "ts"),
    )

    security: Mapped["Security"] = relationship("Security", back_populates="intraday_price_history")

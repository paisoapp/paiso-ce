"""The investment book: every position a user holds, priced once.

The Dashboard, Portfolio and Investments pages used to value investments
separately. ``summary`` priced holdings one way, ``api/holdings`` another, and
the Stocks & Funds page added up its own Market Value in the browser from a
list that hid every 401(k)/HSA account and every position without a ticker.
A synced 401(k) therefore read $73k on the Dashboard and $0 on Investments.

This module is the one place that:

* prices a holding: live quote, else the last stored close, else the
  institution's own mark (:func:`price_holdings`), and says which it used;
* gathers the other sources of investment value: the "Other funds" value of
  a hand-kept plan, and the balance of an account nothing itemises;
* values each account from those sources (``valuation.tracked_account_value``);
  an account is worth its positions at live prices, and its balance only
  when nothing itemises it;
* totals them, which is the ``investment_value`` every page shows.

``summary.get_portfolio_summary`` and ``GET /api/holdings`` both read it, so the
Holdings table and the Dashboard cannot disagree.
"""
from dataclasses import dataclass, field
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.account import Account
from app.models.holding import Holding
from app.modules.accounts import classification
from app.modules.investments.market_data import get_quotes_cached
from app.modules.portfolio.fees import FeePosition, security_er_fraction
from app.modules.portfolio.valuation import (
    INVESTMENT_TYPES,
    AccountValue,
    claims_account,
    stored_prices,
    tracked_account_value,
)

#: Where a position's price came from, as the UI labels it.
#:
#: ``live``         a market quote (possibly a few minutes old)
#: ``close``        the last daily close we stored for a market ticker
#: ``institution``  the price the institution reported (ticker-less plan funds)
#: ``manual``       a unit price the user typed in
#: ``None``         nothing could price it; the position counts at $0
PRICE_SOURCES = ("live", "close", "institution", "manual")


@dataclass
class PricedHolding:
    price: float
    source: str | None
    as_of: date | None = None


async def price_holdings(
    db: AsyncSession, holdings: list[Holding],
) -> tuple[dict[int, PricedHolding], dict[str, dict], set[str]]:
    """Price every holding by the one ladder. Returns the prices by holding id,
    the quote dicts by ticker (for day change), and the tickers whose quote
    was stale or missing (for a background refresh).

    Quotes come from the in-memory cache only; no request blocks on a network
    fetch. A ticker the cache has no price for, and a position with no ticker
    at all, fall back to the stored close and then the institution's mark.
    A ticker-less security's stored "close" was itself written from the
    institution's mark (a statement price), so it is labelled
    ``institution``.
    """
    tickers = list({h.security.ticker for h in holdings if h.security and h.security.ticker})
    quotes: dict[str, dict] = get_quotes_cached(tickers) if tickers else {}
    stale = {t for t in tickers if quotes[t].get("is_stale") or not quotes[t].get("price")}

    def quoted(h: Holding) -> float | None:
        t = h.security.ticker if h.security else None
        price = quotes.get(t, {}).get("price") if t else None
        return float(price) if price else None

    unpriced = [h.security_id for h in holdings if h.security_id is not None and quoted(h) is None]
    stored = await stored_prices(db, unpriced)

    out: dict[int, PricedHolding] = {}
    for h in holdings:
        live = quoted(h)
        if live is not None:
            out[h.id] = PricedHolding(live, "live")
            continue
        sp = stored.get(h.security_id)
        if sp is None:
            out[h.id] = PricedHolding(0.0, None)
            continue
        has_ticker = bool(h.security and h.security.ticker)
        source = "close" if (sp.kind == "close" and has_ticker) else "institution"
        out[h.id] = PricedHolding(sp.price, source, sp.as_of)
        # Hand the stored price to the quote too, so day-change code that reads
        # quotes sees the same number this ladder chose.
        if has_ticker:
            quotes.setdefault(h.security.ticker, {})["price"] = sp.price
    return out, quotes, stale


@dataclass
class InvestmentBook:
    accounts: list[Account]
    holdings: list[Holding]
    prices: dict[int, PricedHolding]
    quotes: dict[str, dict]
    stale_tickers: set[str]
    #: account_id → value of the positions that claim it (non-excluded, shares ≠ 0)
    holdings_value_by_account: dict[int, float]
    #: Manual investment accounts: the "Other funds" value the user entered.
    other_funds_by_account: dict[int, float] = field(default_factory=dict)

    def holding_value(self, h: Holding) -> float:
        return float(h.shares or 0) * self.prices[h.id].price

    def account_value(self, account: Account, fallback_balance: float | None = None) -> AccountValue:
        return tracked_account_value(
            account.id,
            holdings=self.holdings_value_by_account,
            other_funds=self.other_funds_by_account,
            fallback_balance=(
                float(account.current_balance or 0)
                if fallback_balance is None else fallback_balance
            ),
        )


async def build_investment_book(db: AsyncSession, user_id: int) -> InvestmentBook:
    """Load and price every investment position the user has."""
    accounts = (await db.scalars(
        select(Account)
        .where(Account.user_id == user_id)
        .options(selectinload(Account.institution))
    )).all()
    account_ids = [a.id for a in accounts]

    holdings = (await db.scalars(
        select(Holding)
        .where(Holding.account_id.in_(account_ids))
        .options(selectinload(Holding.account), selectinload(Holding.security))
        .order_by(Holding.account_id, Holding.id)
    )).all() if account_ids else []
    prices, quotes, stale = await price_holdings(db, list(holdings))

    holdings_value: dict[int, float] = {}
    for h in holdings:
        if h.exclude_from_net_worth or not claims_account(h.shares):
            continue
        holdings_value[h.account_id] = (
            holdings_value.get(h.account_id, 0.0) + float(h.shares or 0) * prices[h.id].price
        )

    book = InvestmentBook(
        accounts=list(accounts),
        holdings=list(holdings),
        prices=prices,
        quotes=quotes,
        stale_tickers=stale,
        holdings_value_by_account=holdings_value,
    )

    # ── Hand-kept plans: the part no ticker covers, as the user entered it ──
    for a in accounts:
        if (a.account_type in INVESTMENT_TYPES
                and a.other_funds_value is not None):
            book.other_funds_by_account[a.id] = float(a.other_funds_value)
    return book


@dataclass
class InvestmentTotals:
    investment_value: float = 0.0
    #: Gain is measured against this, not investment_value: "Other funds" and
    #: balance-only accounts carry no basis.
    total_cost_basis: float = 0.0
    costed_value: float = 0.0
    by_account_type: dict[str, float] = field(default_factory=dict)
    fee_positions: list[FeePosition] = field(default_factory=list)
    #: The value each investment account contributes, by account id. An
    #: account that contributes nothing (no source, no balance) is absent.
    account_values: dict[int, AccountValue] = field(default_factory=dict)
    #: The same money by what it is for and how it is taxed
    #: (modules/accounts/classification). Tax treatment ``None`` = not modelled.
    by_purpose: dict[str, float] = field(default_factory=dict)
    by_purpose_tax: dict[tuple[str, str | None], float] = field(default_factory=dict)

    def _add(self, account_type: str, value: float, account=None,
             purpose: str | None = None, tax: str | None = None) -> None:
        self.investment_value += value
        self.by_account_type[account_type] = self.by_account_type.get(account_type, 0.0) + value
        if account is not None:
            purpose = classification.purpose(account) or purpose
            tax = classification.tax_treatment(account) if purpose else tax
        purpose = purpose or "other"
        self.by_purpose[purpose] = self.by_purpose.get(purpose, 0.0) + value
        key = (purpose, tax)
        self.by_purpose_tax[key] = self.by_purpose_tax.get(key, 0.0) + value


def investment_totals(book: InvestmentBook) -> InvestmentTotals:
    """The investment value every page reports, and how it splits."""
    out = InvestmentTotals()
    investment_ids = {a.id for a in book.accounts if a.account_type in INVESTMENT_TYPES}

    # Holdings: their value counts wherever they sit, the same as before this
    # module existed.
    for h in book.holdings:
        if h.exclude_from_net_worth or (h.account is not None and h.account.exclude_from_net_worth):
            continue
        value = book.holding_value(h)
        cost = float(h.cost_basis_total or 0)
        acct_type = h.account.account_type if h.account else "other"
        out._add(acct_type, value, h.account)
        if cost > 0:
            out.total_cost_basis += cost
            out.costed_value += value
        out.fee_positions.append(FeePosition(
            name=h.security.name,
            ticker=h.security.ticker,
            source="holding",
            value=value,
            expense_ratio=security_er_fraction(h.security.expense_ratio, h.security.type),
        ))

    # Each investment account: add what the passes above did not.
    for acct in book.accounts:
        if acct.id not in investment_ids:
            continue
        av = book.account_value(acct)
        if acct.exclude_from_net_worth:
            # Listed (its rows are marked excluded) but not counted.
            if av.tracked or av.value > 0:
                out.account_values[acct.id] = av
            continue
        if not av.tracked:
            if av.value > 0:
                out._add(acct.account_type, av.value, acct)
                out.account_values[acct.id] = av
            continue
        extra = book.other_funds_by_account.get(acct.id, 0.0)
        if extra:
            out._add(acct.account_type, extra, acct)
        out.account_values[acct.id] = av

    return out


# ── Rows for the Holdings table ──────────────────────────────────────────────
#: What a Holdings row is. ``holding`` rows come from api/holdings (they carry
#: trades, day change and so on); the rest are built here.
ROW_KINDS = ("holding", "balance", "other_funds")


def _row(*, kind: str, row_key: str, synthetic_id: int, account, name: str,
         value: float, excluded: bool = False, **fields) -> dict:
    """A non-holding row in the shape of a holding row, so one table renders
    every kind. Fields a kind has no answer for are None, never 0: an unknown
    cost basis is not a cost of zero."""
    row = {
        "id": synthetic_id,
        "row_key": row_key,
        "kind": kind,
        "account_id": account.id if account is not None else None,
        "account_name": account.display_name if account is not None else None,
        "security_id": None,
        "ticker": None,
        "name": name,
        "type": kind,
        "expense_ratio": None,
        "shares": None,
        "cost_basis_total": None,
        "acquired_at": None,
        "lot_method": None,
        "price": None,
        "price_source": None,
        "price_as_of": None,
        "current_value": value,
        "day_change": 0.0,
        "day_change_pct": 0.0,
        "day_gain": 0.0,
        "day_change_session": None,
        "day_high": None,
        "day_low": None,
        "week52_high": None,
        "week52_low": None,
        "total_gain": None,
        "total_gain_pct": None,
        "exclude_from_net_worth": excluded,
        "is_favorited": False,
        "has_trades": False,
        "synced_position": False,
        # Kept for older clients, which hid these rows.
        "is_balance_account": kind == "balance",
        "value_source": None,
        # The account's own flag, for the drawer's checkbox (excluded above is
        # whether the row counts).
        "account_excluded": bool(getattr(account, "exclude_from_net_worth", False)),
    }
    row.update(fields)
    return row


def position_rows(book: InvestmentBook, totals: InvestmentTotals) -> list[dict]:
    """Every row of the Holdings table that is not a Holding.

    Together with the holding rows, the rows not excluded from net worth add
    up to ``totals.investment_value``: a test pins it.
    """
    accounts = {a.id: a for a in book.accounts}
    rows: list[dict] = []

    # Hand-kept plans: the value the user entered for funds with no ticker.
    for account_id, value in book.other_funds_by_account.items():
        acct = accounts[account_id]
        rows.append(_row(
            kind="other_funds", row_key=f"of:{account_id}", synthetic_id=-5_000_000 - account_id,
            account=acct, name="Other funds", value=value,
            price_source="manual",
            price_as_of=acct.other_funds_as_of.isoformat() if acct.other_funds_as_of else None,
            value_source="positions",
        ))

    # Accounts valued as a single number: nothing itemises them (a 401(k) or
    # HSA kept as a balance).
    for account_id, av in totals.account_values.items():
        acct = accounts[account_id]
        if av.value_source == "balance":
            rows.append(_row(
                kind="balance", row_key=f"bal:{account_id}", synthetic_id=-3_000_000 - account_id,
                account=acct, name=acct.display_name, value=av.value,
                price_as_of=acct.balance_as_of.isoformat() if acct.balance_as_of else None,
                price_source="manual",
                value_source="balance",
                excluded=bool(acct.exclude_from_net_worth),
            ))
    return rows

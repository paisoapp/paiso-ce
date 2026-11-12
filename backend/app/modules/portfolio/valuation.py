"""Shared account-classification and account-valuation rules.

Three modules reconstruct net worth from the same data — ``summary`` (the
hero card), ``breakdown`` (the per-account table) and ``net_worth_history``
(the trend chart).  Each used to carry its own copy of the account-type sets
and its own idea of what an account is worth, and the three copies had
drifted.  This module is the single source of truth for both.

Two rules live here:

1. **Account classification.**  ``mortgage`` is a real ``ACCOUNT_TYPES``
   member that every previous copy of these sets forgot, so a mortgage
   account contributed nothing to liabilities and net worth read too high.
   See :data:`LOAN_TYPES`.

2. **Tracked value is additive, not exclusive.**  An investment account can
   legitimately be valued from several sources at once — an HSA
   routinely holds a tickered fund (``Holding``) *and* funds with no ticker
   entered as one "Other funds" value.  An ``if / elif`` chain over the
   sources returned only the first, so one tickered holding made the rest of
   the account's value disappear.  :func:`tracked_account_value` sums every
   source instead, and only falls back to the manually-entered balance when
   no source tracks the account at all.

3. **An account is worth its positions at live prices.**  Its balance is
   used only when nothing tracks it.  A position with no quotable ticker is
   priced at the last price stored for it.
"""
from datetime import date
from typing import Mapping, NamedTuple

# ── Account classification ──────────────────────────────────────────────────
CASH_TYPES: frozenset[str] = frozenset({"checking", "savings"})
INVESTMENT_TYPES: frozenset[str] = frozenset(
    {"brokerage", "401k", "ira", "roth_ira", "hsa", "529"}
)

CREDIT_CARD_TYPES: frozenset[str] = frozenset({"credit_card"})

# ``mortgage`` belongs here.  It is in ACCOUNT_TYPES, but it was absent from
# every debt set, so the balance was silently dropped from liabilities.
LOAN_TYPES: frozenset[str] = frozenset({"loan", "mortgage"})

DEBT_TYPES: frozenset[str] = CREDIT_CARD_TYPES | LOAN_TYPES


def is_asset_backed_loan_account(account) -> bool:
    """True when this account's debt is already counted via its linked Asset.

    ``POST /api/mortgage`` creates an Account + Asset + Loan trio and sets
    ``Account.linked_asset_id``.  The debt is reported from ``Asset.loan``,
    so counting the account balance as well would double it.  Loan accounts
    created any other way have no linked asset and must be counted from their own balance.
    """
    return (
        account.account_type in LOAN_TYPES
        and getattr(account, "linked_asset_id", None) is not None
    )


def loan_account_debt(account) -> float:
    """Positive amount owed on a standalone loan/mortgage account.

    Returns 0.0 when the debt is already counted via a linked Asset.  The
    sign of ``current_balance`` varies by source (some OFX exports report a
    loan balance as negative, a hand-entered one is usually positive), so the
    magnitude
    is what counts — matching how net_worth_history has always treated
    loan balances.
    """
    if is_asset_backed_loan_account(account):
        return 0.0
    return abs(float(account.current_balance or 0))


# ── Asset-backed loan balances ──────────────────────────────────────────────
def loan_balance_at(loan, target: date, *, schedule=None) -> float:
    """Remaining balance of an asset-backed ``Loan`` at ``target``.

    Priority:
    1. Stored payment_schedule entries (most accurate, handles extra payments).
    2. Standard amortization formula using original loan parameters.

    ``balance_override`` is intentionally ignored here: it is a current-balance
    anchor, and using it for a historical date would flat-line every date
    before ``balance_override_date``. :func:`current_loan_balance` is the
    override-aware "what is owed now" figure.

    ``schedule`` defaults to ``loan.payment_schedule``; pass rows explicitly
    when the relationship is not loaded.
    """
    schedule = loan.payment_schedule if schedule is None else schedule
    if schedule:
        paid = [
            (ps.payment_date, float(ps.balance))
            for ps in schedule
            if ps.payment_date <= target
        ]
        if paid:
            return max(0.0, max(paid)[1])

    principal = float(loan.principal)
    start = loan.origination
    term = loan.term_months

    if target <= start:
        return principal

    months_elapsed = min(
        (target.year - start.year) * 12 + (target.month - start.month),
        term,
    )

    r = float(loan.rate_apr) / 100 / 12
    if r == 0:
        return max(0.0, principal - (principal / term) * months_elapsed)

    N, n = float(term), float(months_elapsed)
    factor = (1 + r) ** N
    return max(0.0, principal * (factor - (1 + r) ** n) / (factor - 1))


def current_loan_balance(loan, as_of: date | None = None, *, schedule=None) -> float:
    """What is owed on an asset-backed ``Loan`` today.

    The one rule the summary card, the breakdown table and the property page
    share. They used to disagree three ways — the summary fell back to the
    *original* principal, the breakdown to $0, the property page to the
    balance after the *next* payment.

    A user-supplied ``balance_override`` wins, carried forward by any
    payments the schedule (re-projected from that override) says have been
    made since ``balance_override_date``. Otherwise the balance comes from
    the schedule or the amortization formula at ``as_of``.
    """
    as_of = as_of or date.today()
    schedule = loan.payment_schedule if schedule is None else schedule
    if loan.balance_override is not None:
        anchor = loan.balance_override_date
        since = [
            (ps.payment_date, float(ps.balance))
            for ps in (schedule or [])
            if (anchor is None or ps.payment_date > anchor) and ps.payment_date <= as_of
        ]
        if since:
            return max(0.0, max(since)[1])
        return max(0.0, float(loan.balance_override))
    return loan_balance_at(loan, as_of, schedule=schedule)


def ownership_share(asset) -> float:
    """The fraction of an asset this user owns (``ownership_pct`` as 0–1)."""
    pct = asset.ownership_pct
    return float(100 if pct is None else pct) / 100


def owned_loan_balance(asset, as_of: date | None = None) -> float:
    """The user's share of what is owed on an asset's loan.

    The loan is scaled by the same ``ownership_pct`` as the asset's value.
   Counting half of a co-owned home against the whole of its
    mortgage understated net worth by the co-owner's share of the debt.
    """
    if not asset.loan:
        return 0.0
    return current_loan_balance(asset.loan, as_of) * ownership_share(asset)


# ── Account valuation ───────────────────────────────────────────────────────
class AccountValue(NamedTuple):
    value: float
    #: True when at least one tracking source covers this account, so the
    #: value is computed rather than a manually-entered balance.
    tracked: bool
    #: Which sources contributed, e.g. ``{"holdings", "other_funds"}``.
    sources: frozenset[str]


    @property
    def value_source(self) -> str:
        """Where the number came from, for the UI: ``positions`` (holdings
        or "Other funds") or ``balance`` (the account's own stored
        balance, nothing tracking it)."""
        return "positions" if self.tracked else "balance"


def tracked_account_value(
    account_id: int,
    *,
    holdings: Mapping[int, float] | None = None,
    other_funds: Mapping[int, float] | None = None,
    fallback_balance: float = 0.0,
) -> AccountValue:
    """Sum every tracked value for one account, else fall back to its balance.

    Each argument maps ``account_id -> value`` for one tracking source.
    Membership decides whether a source counts, not whether its value is
    positive: an account whose positions really are worth $0 stays tracked
    at $0 rather than reverting to a stale manual balance.
    """
    total = 0.0
    sources: set[str] = set()
    for name, source in (
        ("holdings", holdings),
        # What a hand-kept plan holds beyond its tickers, entered as one value.
        ("other_funds", other_funds),
    ):
        if source is not None and account_id in source:
            total += float(source[account_id] or 0)
            sources.add(name)

    if sources:
        return AccountValue(total, True, frozenset(sources))
    return AccountValue(float(fallback_balance or 0), False, frozenset())


def claims_account(shares) -> bool:
    """Whether a Holding row makes its account "tracked by holdings".

    Only a position actually held does. Zero-share rows are kept on purpose —
    a sold-out position keeps its cost basis and trades, or one the
    institution reports at nothing — but they hold nothing, so they must not
    stop the account falling back to that balance. Treating them as
    membership valued a stock-plan account at $0 while the institution
    reported its real value.
    """
    return float(shares or 0) != 0


class StoredPrice(NamedTuple):
    price: float
    as_of: date | None
    #: ``close``: a persisted daily close.
    kind: str


async def stored_prices(db, security_ids) -> dict[int, StoredPrice]:
    """:func:`fallback_prices`, with the date and kind of each price."""
    ids = [i for i in set(security_ids or ()) if i is not None]
    return {sid: StoredPrice(price, as_of, "close")
            for sid, (price, as_of) in (await _latest_closes_dated(db, ids)).items()}


async def fallback_prices(db, security_ids) -> dict[int, float]:
    """The best stored price per security id, for anything a live quote
    cannot price: the latest daily close we persisted."""
    return {sid: p.price for sid, p in (await stored_prices(db, security_ids)).items()}


async def _latest_closes_dated(db, security_ids) -> dict[int, tuple[float, date]]:
    ids = [i for i in set(security_ids or ()) if i is not None]
    if not ids:
        return {}

    from sqlalchemy import select

    from app.models.security import PriceHistory

    rows = (await db.execute(
        select(PriceHistory.security_id, PriceHistory.close, PriceHistory.as_of)
        .where(PriceHistory.security_id.in_(ids))
        .order_by(PriceHistory.security_id, PriceHistory.as_of.desc())
    )).all()

    out: dict[int, tuple[float, date]] = {}
    for security_id, close, as_of in rows:
        if security_id not in out and close is not None:
            out[security_id] = (float(close), as_of)
    return out

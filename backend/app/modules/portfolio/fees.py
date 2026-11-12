"""Fund-fee (expense ratio) analysis for the Portfolio page.

Two things made the old figures wrong, and both are handled here:

1. **Units differ by source.**  ``Security.expense_ratio`` is a *percent* —
   the Add Holding form asks for "Expense Ratio (%)" and yfinance's
   ``netExpenseRatio`` is a percent too (VOO → 0.03).  The summary used to
   multiply a percent straight into dollars, so fees read 100× too high.
   :func:`security_er_fraction` turns it into a fraction before it reaches
   :func:`summarize_fees`.

2. **Unknown is not zero.**  A fund whose ratio we do not know used to count
   as 0%, and so did every balance-only account, which
   diluted the weighted ratio toward zero.  Here a position either has a
   known ratio (a stock is a known 0%) or it is unknown; the weighted ratio is
   taken over known value only, and coverage is reported so the UI can say
   how much of the portfolio the number actually describes.
"""
from dataclasses import dataclass

#: Security types that carry no fund-level expense ratio at all. Individual
#: bonds ("fixed income") behave like stocks here — bond *funds* are
#: reported as etf / mutual_fund.
NO_FEE_SECURITY_TYPES: frozenset[str] = frozenset({"stock", "cash", "crypto", "fixed_income"})

#: Growth rate assumed when projecting what fees cost over time. Shown in the
#: UI next to the figure; it is an illustration, not a forecast.
FEE_PROJECTION_GROWTH = 0.06
FEE_PROJECTION_YEARS = 10


@dataclass(frozen=True)
class FeePosition:
    name: str
    ticker: str | None
    #: "holding"
    source: str
    value: float
    #: Decimal fraction (0.0003 = 0.03%), or None when unknown.
    expense_ratio: float | None


def security_er_fraction(expense_ratio_pct, security_type: str | None) -> float | None:
    """A ``Security``'s expense ratio as a fraction, or None when unknown.

    ``Security.expense_ratio`` is stored as a percent. Types that never carry
    a fund fee (stocks, cash, crypto, individual bonds) are a known 0.
    """
    if expense_ratio_pct is not None:
        return float(expense_ratio_pct) / 100
    if (security_type or "").lower() in NO_FEE_SECURITY_TYPES:
        return 0.0
    return None


def summarize_fees(positions: list[FeePosition], *, top_n: int = 5) -> dict:
    """Aggregate fee positions into the Portfolio page's Fee Analysis block.

    ``weighted_expense_ratio`` is a percent (0.03 = 0.03%) to match the API's
    long-standing contract; ``top_costs[].expense_ratio`` is a percent too.
    """
    fee_bearing_value = 0.0
    known_value = 0.0
    annual_fee = 0.0
    unknown_value = 0.0
    unknown_count = 0
    projected_cost = 0.0

    growth = 1 + FEE_PROJECTION_GROWTH
    gross_factor = growth ** FEE_PROJECTION_YEARS

    # Same fund held in several accounts reads as one line.
    by_fund: dict[tuple[str, str], dict] = {}
    # The funds behind `unknown_count`, deduped the same way. The card used to
    # report only how many there were and send people to Investments to guess
    # which; naming them is the difference between a number and a to-do list.
    unknown_by_fund: dict[tuple[str, str], dict] = {}

    for p in positions:
        if p.value <= 0:
            continue
        fee_bearing_value += p.value
        if p.expense_ratio is None:
            unknown_value += p.value
            unknown_count += 1
            key = (p.source, (p.ticker or p.name).upper())
            row = unknown_by_fund.setdefault(key, {
                "name": p.name,
                "ticker": p.ticker,
                "source": p.source,
                "value": 0.0,
            })
            row["value"] += p.value
            continue

        known_value += p.value
        fee = p.value * p.expense_ratio
        annual_fee += fee
        projected_cost += p.value * (
            gross_factor - (growth * (1 - p.expense_ratio)) ** FEE_PROJECTION_YEARS
        )

        if fee <= 0:
            continue
        key = (p.source, (p.ticker or p.name).upper())
        row = by_fund.setdefault(key, {
            "name": p.name,
            "ticker": p.ticker,
            "source": p.source,
            "value": 0.0,
            "annual_fee": 0.0,
        })
        row["value"] += p.value
        row["annual_fee"] += fee

    top_costs = sorted(by_fund.values(), key=lambda r: r["annual_fee"], reverse=True)[:top_n]
    # Biggest holdings first — those are the ones whose missing ratio moves the
    # weighted average most. Capped like top_costs; `unknown_count` stays the
    # true total so the card can say "and 3 more".
    unknown_funds = sorted(
        unknown_by_fund.values(), key=lambda r: r["value"], reverse=True
    )[:top_n]
    for row in unknown_funds:
        row["value"] = round(row["value"], 2)
    for row in top_costs:
        row["expense_ratio"] = round(row["annual_fee"] / row["value"] * 100, 4) if row["value"] else 0.0
        row["value"] = round(row["value"], 2)
        row["annual_fee"] = round(row["annual_fee"], 2)

    weighted = (annual_fee / known_value) if known_value > 0 else 0.0
    return {
        "fee_bearing_value": round(fee_bearing_value, 2),
        "er_known_value": round(known_value, 2),
        "coverage_pct": round(known_value / fee_bearing_value * 100, 1) if fee_bearing_value > 0 else 0.0,
        "weighted_expense_ratio": round(weighted * 100, 4),
        "annual_fee": round(annual_fee, 2),
        "projected_fee_cost": round(projected_cost, 2),
        "projection_years": FEE_PROJECTION_YEARS,
        "projection_growth_pct": FEE_PROJECTION_GROWTH * 100,
        #: Positions with no ratio. One fund held in two accounts counts twice.
        "unknown_count": unknown_count,
        #: Distinct funds behind those positions — what the UI says out loud,
        #: because "3 funds" reading as 3 positions of the same fund is a lie.
        "unknown_fund_count": len(unknown_by_fund),
        "unknown_value": round(unknown_value, 2),
        #: Which funds those are, largest holding first, capped at `top_n`.
        "unknown_funds": unknown_funds,
        "top_costs": top_costs,
    }

"""Investments → Overview: the user's investment accounts grouped by what the
money is for, each group split by how it is taxed.

Built on the same book as the Dashboard and the Holdings table
(modules/portfolio/positions). Its figures are market values: what the user
excluded from net worth still counts here, so the total is the Dashboard's
investment value plus ``excluded_total``.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.models.user import User
from app.modules.accounts import classification
from app.modules.portfolio.positions import build_investment_book, investment_totals
from app.modules.portfolio.valuation import claims_account
from app.modules.portfolio.valuation import INVESTMENT_TYPES

router = APIRouter(prefix="/api/investments", tags=["investments"])

#: A price the user typed is "stale" after this long, and the page says so.
MANUAL_PRICE_STALE_DAYS = 30

#: Tax treatments in display order; None (not modelled) last.
_TAX_ORDER = ("tax_deferred", "tax_free", "taxable", None)


def _tax_key(t: str | None) -> str:
    return t or "not_set"


def _hand_updated_on(acct, av, has_tickers: bool):
    """The date of the value the user last typed for a hand-kept plan: its
    Other funds, or its balance when nothing else values it."""
    if acct.other_funds_value is not None:
        return acct.other_funds_as_of.isoformat() if acct.other_funds_as_of else None
    if not has_tickers and (av is None or av.value_source == "balance"):
        return acct.balance_as_of.isoformat() if acct.balance_as_of else None
    return None


def _stale(acct, av, has_tickers: bool, stale_before: date) -> dict:
    on = _hand_updated_on(acct, av, has_tickers)
    if on is None:
        has_typed = (acct.other_funds_value is not None or (
            not has_tickers and (av is None or av.value_source == "balance") and (av and av.value)))
        return {"stale": bool(has_typed)}
    return {"stale": date.fromisoformat(on) < stale_before}


@router.get("/overview")
async def investments_overview(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    book = await build_investment_book(db, user.id)
    totals = investment_totals(book)

    stale_before = date.today() - timedelta(days=MANUAL_PRICE_STALE_DAYS)
    tickered = {h.account_id for h in book.holdings
                if float(h.shares or 0) != 0 and h.security and h.security.ticker}

    # Holdings the user excluded from net worth one by one. The book leaves
    # them out of their account's value; Investments counts them.
    excluded_holdings: dict[int, float] = {}
    for h in book.holdings:
        if h.exclude_from_net_worth and claims_account(h.shares) and h.account_id:
            excluded_holdings[h.account_id] = excluded_holdings.get(h.account_id, 0.0) + book.holding_value(h)

    cards_by_purpose: dict[str, list[dict]] = {}
    for acct in book.accounts:
        if acct.account_type not in INVESTMENT_TYPES:
            continue
        av = totals.account_values.get(acct.id)
        extra = excluded_holdings.get(acct.id, 0.0)
        if av is None and extra:
            av = book.account_value(acct)
        # A balance-valued account's balance already holds every position.
        value = (av.value + extra if av.tracked else (av.value or extra)) if av else 0.0
        info = classification.describe(acct)
        purpose = info["purpose"] or "other"
        cards_by_purpose.setdefault(purpose, []).append({
            "kind": "account",
            "id": acct.id,
            "name": acct.display_name,
            "institution": acct.institution.name if acct.institution else None,
            # Excluded from net worth: counted on Investments all the same,
            # and shown dimmed. excluded_value is the part net worth leaves
            # out: the whole account, or the holdings excluded one by one.
            "excluded": bool(acct.exclude_from_net_worth),
            "excluded_value": value if acct.exclude_from_net_worth else min(extra, value),
            "account_type": acct.account_type,
            "value": value,
            "value_source": av.value_source if av else "balance",
            "value_as_of": acct.balance_as_of.isoformat() if acct.balance_as_of else None,
            "other_funds_value": float(acct.other_funds_value) if acct.other_funds_value is not None else None,
            "other_funds_as_of": acct.other_funds_as_of.isoformat() if acct.other_funds_as_of else None,
            "other_funds_prev_value": (float(acct.other_funds_prev_value)
                                       if acct.other_funds_prev_value is not None else None),
            "contributions_total": (float(acct.contributions_total)
                                    if acct.contributions_total is not None else None),
            "hsa_coverage": acct.hsa_coverage,
            # When the user last typed a value this plan depends on, for a plan
            # kept by hand. Tickers price themselves. None = nothing
            # hand-typed to go stale.
            "updated_by_hand_on": _hand_updated_on(acct, av, acct.id in tickered),
            **_stale(acct, av, acct.id in tickered, stale_before),
            **info,
        })

    groups = []
    for purpose in classification.PURPOSES:
        cards = cards_by_purpose.get(purpose)
        if not cards:
            continue
        by_tax: dict[str, float] = {}
        for c in cards:
            k = _tax_key(c.get("tax_treatment"))
            by_tax[k] = by_tax.get(k, 0.0) + c["value"]
        by_tax = {k: by_tax[k] for k in map(_tax_key, _TAX_ORDER) if abs(by_tax.get(k, 0.0)) >= 0.005}
        cards.sort(key=lambda c: -c["value"])
        groups.append({
            "purpose": purpose,
            "label": classification.PURPOSE_LABELS[purpose],
            "total": sum(c["value"] for c in cards),
            "by_tax": by_tax,
            "accounts": cards,
        })

    by_tax_all: dict[str, float] = {}
    for g in groups:
        for k, v in g["by_tax"].items():
            by_tax_all[k] = by_tax_all.get(k, 0.0) + v

    stale_manual = sum(
        1 for g in groups for c in g["accounts"] if c.get("stale")
    )

    return {
        "total": sum(g["total"] for g in groups),
        # The part of the total that net worth leaves out.
        "excluded_total": sum(c.get("excluded_value", 0.0) for g in groups for c in g["accounts"]),
        "by_tax": {k: v for k, v in by_tax_all.items() if abs(v) >= 0.005},
        "tax_labels": {**{t: classification.TAX_TREATMENT_LABELS[t] for t in classification.TAX_TREATMENTS},
                       "not_set": "Not set"},
        "groups": groups,
        "stale_manual_prices": stale_manual,
        "manual_price_stale_days": MANUAL_PRICE_STALE_DAYS,
    }


@router.get("/allocation")
async def investments_allocation(
    account_id: int | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Investments by asset class, and the asset classes within each purpose
    and tax treatment. Every position counts once, at the value the Holdings
    table shows, including what the user excluded from net worth. A
    balance nobody itemises is "unclassified" rather than guessed."""
    from sqlalchemy import select

    from app.models.security import Security, SecurityInfo
    from app.modules.investments.asset_class import (
        ASSET_CLASS_LABELS, ASSET_CLASSES, classify, info_dict,
    )
    from app.modules.portfolio.positions import position_rows

    book = await build_investment_book(db, user.id)
    totals = investment_totals(book)
    accounts = {a.id: a for a in book.accounts}

    # (value, asset class, account or None, purpose fallback, tax fallback)
    pieces: list[tuple[float, str, object, str, str | None]] = []

    security_ids = {h.security_id for h in book.holdings if h.security_id}
    infos = dict((await db.execute(
        select(SecurityInfo.security_id, SecurityInfo.info_json)
        .where(SecurityInfo.security_id.in_(security_ids))
    )).all()) if security_ids else {}
    securities = {s.id: s for s in (await db.scalars(
        select(Security).where(Security.id.in_(security_ids))
    )).all()} if security_ids else {}

    def cls_of(security_id, name=None) -> str:
        sec = securities.get(security_id) if security_id else None
        return classify(security=sec, info=info_dict(infos.get(security_id)), name=name)

    for h in book.holdings:
        value = book.holding_value(h)
        if value:
            pieces.append((value, cls_of(h.security_id), h.account, "other", None))

    for row in position_rows(book, totals):
        if not row["current_value"]:
            continue
        acct = accounts.get(row["account_id"]) if row["account_id"] else None
        # A balance or "Other funds" value: nothing says what it holds.
        pieces.append((row["current_value"], "unclassified", acct, "investing", "taxable"))

    # One account (the Overview's account filter): only its pieces.
    if isinstance(account_id, int):
        pieces = [p for p in pieces if p[2] is not None and p[2].id == account_id]

    by_class: dict[str, float] = {}
    by_purpose: dict[str, dict[str, float]] = {}
    by_tax: dict[str, dict[str, float]] = {}
    for value, cls, acct, p_fallback, t_fallback in pieces:
        purpose = (classification.purpose(acct) if acct is not None else None) or (
            p_fallback if acct is None else "other")
        tax = classification.tax_treatment(acct) if acct is not None else t_fallback
        by_class[cls] = by_class.get(cls, 0.0) + value
        by_purpose.setdefault(purpose, {})
        by_purpose[purpose][cls] = by_purpose[purpose].get(cls, 0.0) + value
        by_tax.setdefault(_tax_key(tax), {})
        by_tax[_tax_key(tax)][cls] = by_tax[_tax_key(tax)].get(cls, 0.0) + value

    def ordered(d: dict[str, float]) -> list[dict]:
        return [{"key": c, "label": ASSET_CLASS_LABELS[c], "value": d[c]}
                for c in ASSET_CLASSES if abs(d.get(c, 0.0)) >= 0.005]

    return {
        "total": sum(by_class.values()),
        "asset_classes": [{"key": c, "label": ASSET_CLASS_LABELS[c]} for c in ASSET_CLASSES],
        "by_asset_class": ordered(by_class),
        "by_purpose": [
            {"key": p, "label": classification.PURPOSE_LABELS[p],
             "total": sum(by_purpose[p].values()), "asset_classes": ordered(by_purpose[p])}
            for p in classification.PURPOSES if p in by_purpose
        ],
        "by_tax": [
            {"key": t, "label": {**classification.TAX_TREATMENT_LABELS, "not_set": "Not set"}[t],
             "total": sum(by_tax[t].values()), "asset_classes": ordered(by_tax[t])}
            for t in ("tax_deferred", "tax_free", "taxable", "not_set") if t in by_tax
        ],
    }

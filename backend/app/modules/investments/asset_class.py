"""What a position is invested in: equity, bonds, cash, real estate …

This is the security's classification, separate from the account's. An IRA and
a 529 can both hold a bond fund; the account says how the money is taxed, the
security says what it is exposed to.

The evidence, best first:

1. Our own ``Security.type`` (cash, crypto, fixed_income, target_date_fund …).
2. For a market ticker, yfinance's ``quoteType`` and fund ``category``
   ("Intermediate Core Bond", "Target-Date 2050", "Real Estate") from the
   stored ``SecurityInfo.info_json``, and an equity's ``sector``.
3. The name, for the ticker-less funds plan administrators report
   ("Target Retirement 2050 Trust", "Stable Value Fund").

Anything still unknown is ``unclassified``, shown as such rather than guessed.
"""
import json
import re

#: In display order. The UI gives each a fixed colour by this order.
ASSET_CLASSES = (
    "equity", "fixed_income", "cash", "real_estate", "multi_asset",
    "alternatives", "crypto", "unclassified",
)
ASSET_CLASS_LABELS = {
    "equity": "Stocks",
    "fixed_income": "Bonds",
    "cash": "Cash",
    "real_estate": "Real estate",
    "multi_asset": "Multi-asset",
    "alternatives": "Alternatives",
    "crypto": "Crypto",
    "unclassified": "Unclassified",
}

_SECURITY_TYPE = {
    "cash": "cash",
    "crypto": "crypto",
    "fixed_income": "fixed_income",
    "target_date_fund": "multi_asset",
    "529_portfolio": "multi_asset",
    "stock_option": "equity",
}

_QUOTE_TYPE = {"MONEYMARKET": "cash", "CRYPTOCURRENCY": "crypto", "FUTURE": "alternatives"}

#: Morningstar-style category words, checked in this order.
_CATEGORY_RULES: tuple[tuple[str, str], ...] = (
    (r"target[- ]date|target date|allocation|retirement income|lifecycle|balanced", "multi_asset"),
    (r"money market", "cash"),
    (r"real estate|reit", "real_estate"),
    (r"bond|muni|treasury|government|inflation|credit|fixed income|ultrashort|bank loan|securitized", "fixed_income"),
    (r"commodit|managed futures|alternative|long-short|market neutral|multistrategy|digital asset", "alternatives"),
    (r"blend|growth|value|equity|stock|foreign|emerging|world|small|mid|large|sector|technology|health|financial|utilities|energy|natural resources|communications|consumer|industrials", "equity"),
)

_NAME_RULES: tuple[tuple[str, str], ...] = (
    (r"target|retirement 20\d\d|20\d\d (fund|trust|portfolio)|lifecycle|lifepath|freedom 20|age[- ]based|balanced|allocation", "multi_asset"),
    (r"money market|stable value|cash|sweep|deposit|treasury money|government money", "cash"),
    (r"\breit\b|real estate", "real_estate"),
    (r"bond|treasur|fixed income|income fund|aggregate|tips|municipal|corporate debt", "fixed_income"),
    (r"bitcoin|ethereum|crypto", "crypto"),
    (r"stock|equity|index|s&p|500|total market|growth|value|international|emerging|small cap|mid cap|large cap", "equity"),
)


def _match(rules, text: str) -> str | None:
    t = text.lower()
    for pattern, cls in rules:
        if re.search(pattern, t):
            return cls
    return None


def info_dict(info_json: str | None) -> dict:
    if not info_json:
        return {}
    try:
        out = json.loads(info_json)
    except (TypeError, ValueError):
        return {}
    return out if isinstance(out, dict) else {}


def classify(*, security=None, info: dict | None = None, name: str | None = None) -> str:
    """The asset class of one security (or, with no security, of a fund
    known only by its name)."""
    if security is not None:
        by_type = _SECURITY_TYPE.get(getattr(security, "type", None) or "")
        if by_type:
            return by_type
    info = info or {}
    if info:
        qt = (info.get("quoteType") or "").upper()
        if qt in _QUOTE_TYPE:
            return _QUOTE_TYPE[qt]
        if qt == "EQUITY":
            return "real_estate" if info.get("sector") == "Real Estate" else "equity"
        category = info.get("category")
        if isinstance(category, str) and category:
            found = _match(_CATEGORY_RULES, category)
            if found:
                return found
    label = name or (getattr(security, "name", None) if security is not None else None) or ""
    if label:
        found = _match(_NAME_RULES, label)
        if found:
            return found
    if security is not None and (getattr(security, "type", None) or "") == "stock":
        return "equity"
    return "unclassified"

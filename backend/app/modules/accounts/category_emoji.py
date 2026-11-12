"""The emoji a category starts with.

Categories show an emoji instead of a color. A new or seeded category gets one
from its name: an exact match on the built-in names first, then a keyword in
the name ("Dining Out" finds food), then a plain tag. The user can change it in
Settings → Categories. Migration 0058 carries a frozen copy of these tables for
the categories that existed before.
"""
import re

DEFAULT_EMOJI = "🏷️"
GROUP_EMOJI = "🗂️"

BY_NAME: dict[str, str] = {
    # Groups
    "income": "💰",
    "expense": "🧾",
    "expenses": "🧾",
    "transfer": "🔁",
    "uncategorized": "❓",
    # Income
    "paychecks salary": "💵",
    "salary": "💵",
    "paycheck": "💵",
    "investment income": "📈",
    "business freelance": "💼",
    "gifts received": "🎁",
    "other income": "🪙",
    # Expenses
    "housing": "🏠",
    "mortgage": "🏡",
    "rent": "🏠",
    "utilities": "💡",
    "groceries": "🛒",
    "restaurants": "🍽️",
    "transportation": "🚗",
    "shopping": "🛍️",
    "health medical": "🩺",
    "personal care": "💇",
    "entertainment": "🎬",
    "subscriptions": "🔄",
    "travel": "✈️",
    "insurance": "🛡️",
    "fees charges": "💸",
    "taxes": "🏛️",
    "gifts donations": "🎁",
    "other expenses": "📦",
    # Transfers
    "credit card payment": "💳",
    "savings": "🐷",
    "investments": "📊",
    "retirement contributions": "🏖️",
    "loan payment": "🏦",
    "refunds": "↩️",
    "reimbursement": "🔙",
}

# A category named like its group gets its own emoji, so the two differ
# ("Transfer" inside Transfer).
CATEGORY_BY_NAME: dict[str, str] = {
    "transfer": "↔️",
}

# Checked in order; a phrase with a space matches anywhere in the name, a
# single word matches a whole word or its start.
BY_KEYWORD: list[tuple[str, str]] = [
    ("credit card", "💳"),
    ("grocer", "🛒"),
    ("restaurant", "🍽️"),
    ("dining", "🍽️"),
    ("food", "🍽️"),
    ("coffee", "☕"),
    ("gas", "⛽"),
    ("fuel", "⛽"),
    ("parking", "🅿️"),
    ("car", "🚗"),
    ("auto", "🚗"),
    ("phone", "📱"),
    ("mobile", "📱"),
    ("internet", "🌐"),
    ("electric", "💡"),
    ("water", "💧"),
    ("pet", "🐾"),
    ("child", "🧸"),
    ("kid", "🧸"),
    ("baby", "🧸"),
    ("school", "🎓"),
    ("education", "🎓"),
    ("tuition", "🎓"),
    ("gym", "💪"),
    ("fitness", "💪"),
    ("pharmacy", "💊"),
    ("medical", "🩺"),
    ("doctor", "🩺"),
    ("health", "🩺"),
    ("health", "🏥"),
    ("dental", "🦷"),
    ("home", "🏠"),
    ("house", "🏠"),
    ("rent", "🏠"),
    ("insurance", "🛡️"),
    ("vacation", "✈️"),
    ("travel", "✈️"),
    ("hotel", "🏨"),
    ("gift", "🎁"),
    ("charity", "🤝"),
    ("donation", "🤝"),
    ("tax", "🏛️"),
    ("fee", "💸"),
    ("subscription", "🔄"),
    ("stream", "📺"),
    ("music", "🎵"),
    ("book", "📚"),
    ("cloth", "👕"),
    ("beauty", "💇"),
    ("salon", "💇"),
    ("saving", "🐷"),
    ("invest", "📈"),
    ("dividend", "📈"),
    ("interest", "📈"),
    ("retirement", "🏖️"),
    ("loan", "🏦"),
    ("refund", "↩️"),
    ("reimburse", "🔙"),
    ("bonus", "🎉"),
    ("salary", "💵"),
    ("paycheck", "💵"),
    ("transfer", "🔁"),
    ("income", "💰"),
]


def _normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (name or "").lower()).strip()


def emoji_for(name: str, is_group: bool = False, avoid: frozenset[str] | set[str] = frozenset()) -> str:
    """The emoji for a category (or group) called `name`.

    An emoji in `avoid` (the ones the user's other categories show) is passed
    over for the next match, so a new "Health" group does not take the
    stethoscope Health & Medical already has.
    """
    key = _normalize(name)
    candidates: list[str] = []
    if not is_group and key in CATEGORY_BY_NAME:
        candidates.append(CATEGORY_BY_NAME[key])
    if key in BY_NAME:
        candidates.append(BY_NAME[key])
    words = key.split()
    for needle, emoji in BY_KEYWORD:
        if " " in needle:
            if needle in key:
                candidates.append(emoji)
        elif any(w == needle or (len(needle) >= 3 and w.startswith(needle)) for w in words):
            candidates.append(emoji)
    for emoji in candidates:
        if emoji not in avoid:
            return emoji
    return GROUP_EMOJI if is_group else DEFAULT_EMOJI


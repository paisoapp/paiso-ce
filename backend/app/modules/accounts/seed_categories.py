from sqlalchemy.ext.asyncio import AsyncSession

from app.models.transaction import Category
from app.modules.accounts.category_emoji import emoji_for

# Lean, consumer-focused defaults — a balanced starting point that covers what
# most households need without overwhelming. Users can add, rename, recolor, or
# delete any of these. The built-in auto-categorization resolves its concepts to
# whatever categories exist (see categorizer.CONCEPT_ALIASES), so it keeps
# working even when this list is customized.
#
# "Other Income", "Other Expenses" and the standalone "Uncategorized" root are
# the fallback buckets the categorizer relies on — keep them present.
_INCOME_CHILDREN = [
    "Paychecks/Salary", "Investment Income", "Business / Freelance",
    "Gifts Received", "Other Income",
]

# "Mortgage" is an expense, not a transfer: a homeowner's biggest
# monthly cost was filed as "Loan Payment" under Transfer and left out of
# expenses and the savings rate.
_EXPENSE_CHILDREN = [
    "Housing", "Rent", "Mortgage", "Utilities", "Groceries", "Restaurants", "Transportation",
    "Shopping", "Health & Medical", "Personal Care", "Entertainment",
    "Subscriptions", "Travel", "Education", "Childcare", "Insurance", "Fees & Charges", "Taxes",
    "Gifts & Donations", "Other Expenses",
]

_TRANSFER_CHILDREN = [
    "Transfer", "Credit Card Payment", "Savings", "Investments",
    "Retirement Contributions", "Loan Payment", "Refunds", "Reimbursement",
]

DEFAULT_CATEGORIES = [
    {"name": "Income", "is_income": True, "treatment": "income", "icon": "trending-up", "color": "#22c55e", "children": [
        {"name": n, "is_income": True, "treatment": "income", "icon": "circle", "color": "#16a34a"}
        for n in _INCOME_CHILDREN
    ]},
    {"name": "Expense", "is_income": False, "treatment": "expense", "icon": "trending-down", "color": "#3b82f6", "children": [
        {"name": n, "is_income": False, "treatment": "expense", "icon": "circle", "color": "#2563eb"}
        for n in _EXPENSE_CHILDREN
    ]},
    {"name": "Transfer", "is_income": False, "treatment": "transfer", "icon": "repeat", "color": "#94a3b8", "children": [
        {"name": n, "is_income": False, "treatment": "transfer", "icon": "circle", "color": "#64748b"}
        for n in _TRANSFER_CHILDREN
    ]},
    {"name": "Uncategorized", "is_income": False, "treatment": "expense", "icon": "help-circle", "color": "#cbd5e1"},
]


async def seed_default_categories(user_id: int, db: AsyncSession) -> dict[str, int]:
    """Create default categories for a new user. Returns name→id mapping."""
    name_to_id: dict[str, int] = {}

    for item in DEFAULT_CATEGORIES:
        # NB: read children without mutating the shared module-level
        # DEFAULT_CATEGORIES. A previous `item.pop("children")` permanently
        # stripped the children on the first call, so every subsequently
        # registered user received only the three root categories.
        children = item.get("children", [])
        fields = {k: v for k, v in item.items() if k != "children"}
        # Each starts with an emoji; a root with children is a group.
        fields["icon"] = emoji_for(fields["name"], is_group=bool(children))
        cat = Category(user_id=user_id, is_group=bool(children), **fields)
        db.add(cat)
        await db.flush()
        name_to_id[fields["name"]] = cat.id

        for position, child_data in enumerate(sorted(children, key=lambda c: c["name"].lower())):
            child = Category(
                user_id=user_id, parent_id=cat.id, position=position,
                **{**child_data, "icon": emoji_for(child_data["name"])},
            )
            db.add(child)
            await db.flush()
            name_to_id[child_data["name"]] = child.id

    return name_to_id

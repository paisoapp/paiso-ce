"""Static budgeting benchmarks and default bucket assignments.

Keyed on the default seed-category names (see
``app.modules.accounts.seed_categories``).  Because the keys are names, these
only apply to categories the user hasn't renamed — an unknown name simply gets
no benchmark (and a sensible default bucket), which the UI handles gracefully.

``BENCHMARK_PCT`` values are fractions of *monthly income* — common rules of
thumb, not prescriptions.  They intentionally do not sum to 1.0; the leftover is
the user's discretionary / savings headroom.
"""

# Fraction of monthly income typically allocated to each category.
BENCHMARK_PCT: dict[str, float] = {
    "Housing": 0.28,
    # The same 28% rule: it is a housing cost, and a household has rent or a
    # mortgage, rarely both.
    "Mortgage": 0.28,
    "Rent": 0.28,
    "Utilities": 0.06,
    "Groceries": 0.11,
    "Restaurants": 0.06,
    "Transportation": 0.10,
    "Shopping": 0.05,
    "Health & Medical": 0.06,
    "Personal Care": 0.02,
    "Entertainment": 0.04,
    "Subscriptions": 0.02,
    "Travel": 0.04,
    "Education": 0.03,
    "Childcare": 0.07,
    "Insurance": 0.05,
    "Fees & Charges": 0.01,
    "Taxes": 0.10,
    "Gifts & Donations": 0.03,
    "Savings": 0.10,
    "Investments": 0.05,
    "Retirement Contributions": 0.10,
    "Loan Payment": 0.08,
}

# Default Needs / Wants / Savings bucket per default category name.
DEFAULT_BUCKET: dict[str, str] = {
    # Needs
    "Housing": "needs",
    "Mortgage": "needs",
    "Rent": "needs",
    "Utilities": "needs",
    "Groceries": "needs",
    "Transportation": "needs",
    "Insurance": "needs",
    "Health & Medical": "needs",
    "Taxes": "needs",
    "Education": "needs",
    "Childcare": "needs",
    "Loan Payment": "needs",
    "Fees & Charges": "needs",
    # Wants
    "Restaurants": "wants",
    "Shopping": "wants",
    "Entertainment": "wants",
    "Subscriptions": "wants",
    "Travel": "wants",
    "Personal Care": "wants",
    "Gifts & Donations": "wants",
    "Other Expenses": "wants",
    # Savings
    "Savings": "savings",
    "Investments": "savings",
    "Retirement Contributions": "savings",
}


# Transfer-tree categories that only move money the user already counted
# elsewhere: an account-to-account move, paying off a card whose purchases are
# already spending, money coming back. They are never offered as budget lines
# and never count towards one. The rest of the transfer tree (Savings,
# Investments, Retirement Contributions, Loan Payment) can be budgeted as a
# goal, counted on the leg where the money leaves.
NOT_BUDGETABLE: frozenset[str] = frozenset({
    "Transfer", "Credit Card Payment", "Refunds", "Reimbursement",
})


def is_budgetable(name: str, treatment: str | None) -> bool:
    """Whether a category can carry a budget line at all."""
    if treatment == "income":
        return False
    return not (treatment == "transfer" and name in NOT_BUDGETABLE)


def benchmark_for(name: str, income: float) -> float | None:
    """Suggested monthly amount for a category given monthly income, or None."""
    pct = BENCHMARK_PCT.get(name)
    if pct is None or income <= 0:
        return None
    return float(round(pct * income))


def default_bucket_for(name: str, treatment: str | None = None) -> str:
    """Default bucket for a category — falls back on treatment, then 'wants'."""
    if name in DEFAULT_BUCKET:
        return DEFAULT_BUCKET[name]
    if treatment == "transfer":
        return "savings"
    return "wants"

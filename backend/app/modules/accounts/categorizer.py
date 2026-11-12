import re
from collections import Counter
from datetime import date

import regex
import structlog
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.validation import RULE_MATCH_TIMEOUT_SECS
from app.models.account import Account
from app.models.category_rule import CategoryRule
from app.models.transaction import Category, Transaction

log = structlog.get_logger()

# Built-in heuristic patterns: (regex, concept).
# Checked in order; first match wins.
#
# Heuristics emit a *concept*, not a literal category name. The concept is then
# resolved to whichever of the user's categories best fits via CONCEPT_ALIASES
# (see resolve_concept). This decouples the heuristics from any particular
# category list: users can rename, delete, or build their own simpler set, and a
# concept simply resolves to the closest existing category — or, if none fits,
# the heuristic skips silently rather than mis-firing. Long-term, per-merchant
# accuracy comes from Stage 0 history learning, which is fully name-agnostic.
HEURISTIC_PATTERNS: list[tuple[str, str]] = [
    # Fees first, so "interest charge" beats the income "interest" rule below.
    (r"\b(interest charge|finance charge|late fee|annual fee|atm fee|foreign transaction|service charge|overdraft)\b", "fees"),
    # Income signals. "payroll" is often glued to digits in ACH descriptors
    # (e.g. "PAYROLL411"), so do NOT require a trailing word boundary.
    (r"\bpayroll", "paycheck"),
    (r"\b(direct dep|dir dep|directdep|salary|wages|adp|gusto|paychex|workday|intuit pyrl)\b", "paycheck"),
    (r"\bdividend", "investment_income"),
    (r"\binterest\b", "investment_income"),
    # A card payment, seen from either side: "Payment Thank You-Mobile" on
    # the card, "CHASE CREDIT CRD AUTOPAY" on checking.
    (r"(\bpayment\W*thank|thank you for (your )?payment|\bcredit (crd|card) (autopay|epay|payment|pymt|pmt)|\bpayment to [a-z ]*card\b)", "credit_card_payment"),
    # A mortgage payment is a housing expense, before the transfer rules.
    (r"\b(mortgage|mtg pmt|mtg payment|home loan pmt)\b", "mortgage_payment"),
    # Transfers
    (r"\b(venmo|zelle|paypal|cash app|cashapp|square cash)\b", "transfer"),
    (r"\btransfer\b", "transfer"),
    # Food
    (r"\b(whole foods|trader joe|kroger|safeway|publix|wegmans|sprouts|aldi|costco|sam.?s club|bj.?s)\b", "groceries"),
    (r"\b(walmart|target|meijer|hyvee|winco|fred meyer)\b", "groceries"),
    (r"\b(grocer|supermarket|food market|food mart)", "groceries"),
    (r"\b(h-e-b|heb|central market|h ?mart|patel brothers|99 ranch|fiesta mart|randalls|tom thumb|albertsons|vons|ralphs|food lion|harris teeter|giant eagle|stop & shop|winn-dixie|king soopers|food 4 less|grocery outlet)\b", "groceries"),
    (r"\b(starbucks|dunkin|dutch bros|peet.?s|tim hortons)\b", "restaurants"),
    (r"\b(mcdonald|burger king|wendy.?s|taco bell|chick-fil|chipotle|domino|pizza hut|subway|panera)\b", "restaurants"),
    (r"\b(doordash|grubhub|uber eats|instacart|postmates)\b", "restaurants"),
    (r"\b(restaurant|cafe|coffee|diner|grill|pizzeria|bakery|bistro|eatery|steakhouse|sushi|taqueria|cantina|brewery)", "restaurants"),
    (r"\b(kabab|kebab|burgers?|bbq|barbecue|ramen|pho|biryani|shawarma|halal|tandoor|wings)\b", "restaurants"),
    # Transportation
    (r"\b(uber|lyft|via ride)\b", "rideshare"),
    (r"\b(shell|chevron|exxon|mobil|bp |arco|sunoco|speedway|marathon)\b", "gas"),
    (r"\b(gasoline|fuel|gas station)\b", "gas"),
    (r"\b(mta|bart|cta|metro|transit|wmata|septa|mbta)\b", "transit"),
    # Health
    (r"\b(cvs|walgreens|rite aid|duane reade)\b", "health"),
    (r"\b(eye ?care|optometr|optical|vision center|dental|dentist|orthodont|clinic|medical|hospital|physician|pharmac|dermatolog|pediatric|urgent care|health ?care|chiropract|radiolog|laborator|diagnostic)", "health"),
    (r"\b(planet fitness|la fitness|equinox|24 hour fitness|crunch|ymca|anytime fitness|gym|salon|barber|haircut)\b", "personal_care"),
    # Shopping
    (r"\bamazon\b", "shopping"),
    (r"\b(apple\.com|apple store)\b", "subscriptions"),
    (r"\b(best buy|newegg|b&h)\b", "electronics"),
    (r"\b(h&m|zara|gap|old navy|uniqlo|nordstrom|macy.?s|jcpenney|kohls|tjmaxx|marshalls)\b", "clothing"),
    # Entertainment / Subscriptions
    (r"\b(netflix|hulu|disney\+|hbo|max |peacock|paramount|apple tv)\b", "subscriptions"),
    (r"\b(spotify|apple music|tidal|pandora|youtube premium)\b", "subscriptions"),
    (r"\bsteam\b", "entertainment"),
    # Travel
    # The airline word is required: a bare "united" matched "UNITED STATES".
    (r"\b(delta air|american air|united air|southwest air|spirit airl|frontier airl|jetblue|alaska air)", "travel"),
    (r"\b(marriott|hilton|hyatt|ihg|airbnb|vrbo|expedia|booking\.com)\b", "travel"),
    (r"\b(airline|hotel|motel|resort|car rental|rent.?a.?car|hertz|avis|enterprise rent)", "travel"),
    # Taxes
    (r"\b(federal tax|irs|state tax|franchise tax|dept of revenue|dept revenue)\b", "taxes"),
    # Housing / Utilities / Insurance
    (r"\b(pg&e|con ed|pseg|comed|national grid|dominion energy|dte energy|xcel|nv energy)\b", "utilities"),
    (r"\b(at&t|verizon|t-mobile|comcast|xfinity|spectrum|cox|frontier)\b", "utilities"),
    (r"\b(electric|utilit|sewer|water works|natural gas|power & light|gas & electric)", "utilities"),
    (r"\b(insurance|geico|state farm|allstate|progressive|nationwide ins|farmers ins)\b", "insurance"),
    # Childcare before education: "Primrose School" is a daycare.
    (r"\b(daycare|day care|childcare|child care|preschool|kindercare|montessori|bright horizons|primrose school|goddard school)\b", "childcare"),
    (r"\b(tuition|university|college|school district|coursera|udemy|chegg)\b", "education"),
    (r"\b(rent|apartments?|leasing|property management|prop mgmt|bilt)\b", "rent"),
]

_COMPILED = [(re.compile(pat, re.IGNORECASE), concept) for pat, concept in HEURISTIC_PATTERNS]

# Maps each heuristic concept to candidate category names, in priority order.
# resolve_concept() returns the first one that exists among the user's
# categories (case-insensitive). Lists deliberately include both the lean
# default names and the older/granular names so the layer works for legacy
# users and for anyone who builds a simpler list of their own. If nothing
# matches, the concept resolves to None and the heuristic is skipped.
CONCEPT_ALIASES: dict[str, list[str]] = {
    # Income
    "paycheck": ["Paychecks/Salary", "Paycheck", "Salary", "Wages", "Payroll"],
    "investment_income": [
        "Investment Income", "Dividends Received", "Dividends", "Interest",
        "Capital Gains",
    ],
    # Transfers
    "transfer": ["Transfer", "Transfers"],
    # Food
    "groceries": ["Groceries", "Grocery", "Food"],
    "restaurants": [
        "Restaurants", "Restaurants & Dining", "Dining", "Dining Out",
        "Eating Out", "Takeout", "Food",
    ],
    # Transportation — prefer a granular match, then the consolidated bucket
    "gas": ["Gasoline/Fuel", "Gas & Fuel", "Gas", "Fuel", "Transportation", "Transport"],
    "rideshare": ["Rideshare", "Automotive", "Auto", "Transportation", "Transport"],
    "transit": ["Public Transit", "Transit", "Transportation", "Transport", "Travel"],
    # Health
    "health": ["Health & Medical", "Healthcare/Medical", "Health", "Medical", "Pharmacy"],
    "personal_care": ["Personal Care", "Fitness", "Gym", "Wellness"],
    # Shopping
    "shopping": [
        "Shopping", "General Merchandise", "Merchandise", "Amazon / Online",
        "Online Services", "Online Shopping",
    ],
    "electronics": ["Electronics", "Shopping"],
    "clothing": ["Clothing", "Clothing/Shoes", "Apparel", "Shopping"],
    # Entertainment / subscriptions
    "subscriptions": [
        "Subscriptions", "Dues & Subscriptions", "Streaming",
        "Subscriptions & Memberships", "Memberships",
    ],
    "entertainment": ["Entertainment", "Hobbies", "Recreation", "Games"],
    # Travel
    "travel": ["Travel", "Flights", "Hotels", "Vacation", "Trips"],
    # Finance / bills
    "fees": ["Fees & Charges", "Service Charges/Fees", "Fees", "Bank Fees", "Charges"],
    "taxes": ["Taxes", "Tax"],
    "utilities": [
        "Utilities", "Utility", "Internet", "Phone", "Telephone",
        "Cable/Satellite", "Bills",
    ],
    "insurance": ["Insurance"],
    # Transfer-flavored concepts resolve to treatment="transfer" categories so
    # CC/loan payments stay net-worth-neutral.
    "credit_card_payment": ["Credit Card Payment", "Transfer"],
    "loan_payment": ["Loan Payment", "Transfer"],
    # Paying the mortgage from checking is spending, so this resolves
    # to an expense category, never to Loan Payment. The mortgage account's
    # own side of the payment stays "loan_payment".
    "mortgage_payment": ["Mortgage", "Mortgage Payment", "Housing"],
    "savings_transfer": ["Savings", "Transfer"],
    "investments_transfer": ["Investments", "Retirement Contributions", "Transfer"],
    "housing": ["Housing", "Rent", "Bills"],
    "rent": ["Rent", "Housing"],
    "education": ["Education", "Tuition"],
    "childcare": ["Childcare", "Child Care"],
    "transportation": ["Transportation", "Transport", "Automotive", "Auto"],
    "gifts": ["Gifts & Donations", "Donations", "Charity", "Gifts"],
    "refunds": ["Refunds", "Reimbursement"],
}

# Concepts about money moving between accounts or arriving as pay. Their
# patterns run before the bank's own category, so a bank label cannot turn a
# card payment or a transfer into spending.
MONEY_MOVEMENT_CONCEPTS = frozenset({
    "fees", "paycheck", "investment_income", "credit_card_payment",
    "mortgage_payment", "transfer",
})

# The bank's transaction type (Chase's Type column, an OFX TRNTYPE), lower
# case, to a concept. Types that only say "a purchase" are left out.
BANK_TYPE_CONCEPTS: dict[str, str] = {
    "payment": "credit_card_payment",
    "return": "refunds",
    "refund": "refunds",
    "fee": "fees",
    "fee_transaction": "fees",
    "srvchg": "fees",
    "loan_pmt": "loan_payment",
    "acct_xfer": "transfer",
    "xfer": "transfer",
    "directdep": "paycheck",
    "div": "investment_income",
}

# A bank's own category label, normalised by normalize_bank_label(), to a
# concept. Chase's labels come from a real export; the others follow each
# bank's published export format and want a sample file to confirm them.
BANK_CATEGORY_CONCEPTS: dict[str, str] = {
    # Chase
    "groceries": "groceries",
    "food and drink": "restaurants",
    "gas": "gas",
    "automotive": "transportation",
    "travel": "travel",
    "bills and utilities": "utilities",
    "education": "education",
    "health and wellness": "health",
    "personal": "personal_care",
    "entertainment": "entertainment",
    "shopping": "shopping",
    "home": "housing",
    "gifts and donations": "gifts",
    "fees and adjustments": "fees",
    # Capital One
    "grocery": "groceries",
    "dining": "restaurants",
    "gas automotive": "gas",
    "car rental": "travel",
    "airfare": "travel",
    "lodging": "travel",
    "other travel": "travel",
    "phone cable": "utilities",
    "internet": "utilities",
    "health care": "health",
    "merchandise": "shopping",
    "fee interest charge": "fees",
    "payment credit": "credit_card_payment",
    # Discover
    "supermarkets": "groceries",
    "restaurants": "restaurants",
    "gasoline": "gas",
    "travel entertainment": "travel",
    "medical services": "health",
    "department stores": "shopping",
    "home improvement": "housing",
    "fees": "fees",
    "interest": "fees",
    "payments and credits": "credit_card_payment",
    # Amex, the part after the dash
    "restaurant": "restaurants",
    "fuel": "gas",
    "auto services": "transportation",
    "airline": "travel",
    "communications": "utilities",
    "pharmacies": "health",
    "general retail": "shopping",
    "charities": "gifts",
}

# Concepts that only fit money arriving: a "Payment" label or type on a
# purchase says nothing about it.
INCOMING_ONLY_CONCEPTS = frozenset({"credit_card_payment", "refunds"})

# What money arriving on a debt account is, when nothing else says.
DEBT_ACCOUNT_CONCEPTS: dict[str, str] = {
    "credit_card": "credit_card_payment",
    "loan": "loan_payment",
    "mortgage": "loan_payment",
}

# Fallback bucket names. Transactions sitting in these are not treated as a
# meaningful user signal when learning from history (Stage 0).
FALLBACK_NAMES = ("Other Income", "Other Expenses", "Uncategorized")

# Tokens that are pure noise in bank descriptions — dropped during normalization.
_NOISE_TOKENS = re.compile(
    r"\b(pos|purchase|debit card|debit|credit|recurring|payment|ach|web|tel|ref|trn|ppd|des|id|xx+)\b",
    re.IGNORECASE,
)


def normalize_merchant(description: str) -> str:
    """Collapse a raw transaction description to a stable merchant key.

    Lowercases, strips card/reference numbers, masked digits, punctuation and
    common bank noise tokens so that e.g. "AMZN MKTP US*2H4 #1234" and
    "AMZN Mktp US*9KL" map to the same key. Deterministic — used both to learn
    from history and to look transactions up against that history.
    """
    if not description:
        return ""
    text = description.lower()
    text = text.replace("#", " ").replace("*", " ")
    text = re.sub(r"\b\w*\d\w*\b", " ", text)           # drop ref/store/card codes (any token with a digit)
    text = _NOISE_TOKENS.sub(" ", text)
    text = re.sub(r"[^a-z0-9&' ]+", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def heuristic_classify(description: str) -> str | None:
    """Return a concept from the built-in heuristic dictionary, or None.

    The concept is resolved to an actual category by resolve_concept().
    """
    if not description:
        return None
    for pattern, concept in _COMPILED:
        if pattern.search(description):
            return concept
    return None


async def _category_by_name(name: str, user_id: int, db: AsyncSession) -> Category | None:
    """Case-insensitive lookup of a user's category by name."""
    return await db.scalar(
        select(Category).where(
            Category.user_id == user_id,
            func.lower(Category.name) == name.lower(),
        )
    )


async def resolve_concept(concept: str, user_id: int, db: AsyncSession) -> int | None:
    """Resolve a heuristic concept to one of the user's category ids.

    Tries each alias for the concept (case-insensitive) against the user's
    categories and returns the first that exists. Returns None if the user has
    no fitting category — the caller then skips the heuristic rather than
    forcing a poor match.
    """
    aliases = CONCEPT_ALIASES.get(concept)
    if not aliases:
        return None
    cats = (await db.scalars(
        select(Category).where(Category.user_id == user_id)
    )).all()
    by_name = {c.name.strip().lower(): c.id for c in cats}
    for alias in aliases:
        cid = by_name.get(alias.lower())
        if cid is not None:
            return cid
    return None


async def history_classify(
    description: str, user_id: int, db: AsyncSession
) -> int | None:
    """Stage 0: learn from the user's own past categorizations.

    Finds previously-categorized transactions with the same normalized merchant
    and returns their most-frequently-chosen category (tie-break: most recent).
    Only categories the user chose count: learning from the importer's own
    guesses repeated one wrong guess on every later import of that merchant.
    Transactions sitting in the generic fallback buckets are ignored too.
    """
    norm = normalize_merchant(description)
    if not norm:
        return None
    tokens = [t for t in norm.split(" ") if len(t) >= 3]
    if not tokens:
        return None
    anchor = tokens[0]

    # Category ids that are fallback buckets — excluded from the learning signal.
    fallback_ids = set(
        (await db.scalars(
            select(Category.id).where(
                Category.user_id == user_id,
                func.lower(Category.name).in_([n.lower() for n in FALLBACK_NAMES]),
            )
        )).all()
    )

    # Prefilter in SQL on a cheap substring, then match the full normalized key
    # in Python. Capped so a hot merchant can't scan unbounded rows.
    rows = (await db.execute(
        select(
            Transaction.category_id,
            Transaction.description,
            Transaction.date_posted,
        )
        .join(Account, Transaction.account_id == Account.id)
        .where(
            Account.user_id == user_id,
            Transaction.category_id.isnot(None),
            Transaction.category_source == "user",
            Transaction.description.ilike(f"%{anchor}%"),
        )
        .order_by(Transaction.date_posted.desc())
        .limit(500)
    )).all()

    counts: Counter[int] = Counter()
    latest: dict[int, date] = {}
    for cat_id, desc, dt in rows:
        if cat_id in fallback_ids:
            continue
        if normalize_merchant(desc) != norm:
            continue
        counts[cat_id] += 1
        if dt is not None and (cat_id not in latest or dt > latest[cat_id]):
            latest[cat_id] = dt

    if not counts:
        return None
    # Most frequent, tie-broken by most recent use.
    best_id = max(counts, key=lambda cid: (counts[cid], latest.get(cid) or date.min))
    return best_id


def normalize_bank_label(label: str | None) -> str:
    """A bank's category label as a BANK_CATEGORY_CONCEPTS key.

    Lower case, "&" as "and", other punctuation as spaces. Amex labels name a
    group and a category ("Merchandise & Supplies-Groceries"); the category
    after the dash is the part that says where the money went.
    """
    if not label:
        return ""
    text = label.rsplit("-", 1)[-1].lower().replace("&", " and ")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _fits_direction(concept: str | None, amount: float) -> str | None:
    """The concept, unless it only fits money arriving and this money left."""
    if concept in INCOMING_ONLY_CONCEPTS and amount <= 0:
        return None
    return concept


async def _bank_category_id(
    label: str | None, amount: float, user_id: int, db: AsyncSession
) -> int | None:
    """The user's category for a bank's own label, or None.

    A label in BANK_CATEGORY_CONCEPTS resolves through its concept. Any other
    label still lands when it names one of the user's categories, so a bank
    with no row in the map ("Groceries", "Education") is covered too.
    """
    key = normalize_bank_label(label)
    if not key:
        return None
    concept = _fits_direction(BANK_CATEGORY_CONCEPTS.get(key), amount)
    if concept:
        return await resolve_concept(concept, user_id, db)
    if key in BANK_CATEGORY_CONCEPTS:
        return None  # a known label that does not fit this direction
    named = await _category_by_name(label.strip(), user_id, db)
    if named is not None and named.name.lower() not in {n.lower() for n in FALLBACK_NAMES}:
        return named.id
    return None


async def classify_transaction(
    description: str,
    amount: float,
    user_id: int,
    db: AsyncSession,
    transaction_type: str | None = None,
    *,
    account_type: str | None = None,
    bank_type: str | None = None,
    bank_category: str | None = None,
) -> int | None:
    """
    Run the categorization pipeline; the first stage that answers wins:
    0. History: the category the user chose for the same merchant before
    1. User-defined rules
    2. Money movement heuristics (card payments, transfers, pay, fees)
    3. The bank's transaction type (Chase's Type column, an OFX TRNTYPE)
    4. The bank's own category label
    5. Merchant heuristics
    6. Fallback: by account type, then credit → "Other Income",
       debit → "Other Expenses"
    Returns a category_id or None.
    """
    # Stage 0: learn from the user's own history
    learned = await history_classify(description, user_id, db)
    if learned is not None:
        return learned

    # Stage 1: user rules ordered by priority descending
    rules = (await db.scalars(
        select(CategoryRule)
        .where(CategoryRule.user_id == user_id)
        .order_by(CategoryRule.priority.desc())
    )).all()

    # IGNORECASE rather than upper-casing the pattern, which turned \d, \s,
    # \w and \b into their opposites. Each match stops after a time limit,
    # so a pattern saved before patterns were checked cannot stall an import.
    for rule in rules:
        flags = 0 if rule.is_case_sensitive else regex.IGNORECASE
        try:
            if regex.search(rule.pattern, description or "", flags, timeout=RULE_MATCH_TIMEOUT_SECS):
                return rule.category_id
        except regex.error:
            continue  # malformed user pattern — skip
        except TimeoutError:
            log.warning("categorizer.rule_timeout", rule_id=rule.id, user_id=user_id)
            continue

    # A mortgage payment is spending only where the money leaves. On
    # the mortgage account itself the same payment arrives, and filing that
    # side as an expense too would cancel the payment out of the totals.
    incoming = amount > 0

    # Each stage resolves its concept to one of the user's categories and
    # skips silently if none fits (no mis-categorization).
    concept = heuristic_classify(description)
    if concept == "mortgage_payment" and incoming:
        concept = "loan_payment"

    # Stage 2: money movement heuristics
    if concept in MONEY_MOVEMENT_CONCEPTS or concept == "loan_payment":
        resolved = await resolve_concept(concept, user_id, db)
        if resolved is not None:
            return resolved

    # Stage 3: the bank's transaction type
    type_concept = _fits_direction(BANK_TYPE_CONCEPTS.get((bank_type or "").strip().lower()), amount)
    if type_concept:
        resolved = await resolve_concept(type_concept, user_id, db)
        if resolved is not None:
            return resolved

    # Stage 4: the bank's own category
    resolved = await _bank_category_id(bank_category, amount, user_id, db)
    if resolved is not None:
        return resolved

    # Stage 5: merchant heuristics
    if concept and concept not in MONEY_MOVEMENT_CONCEPTS:
        resolved = await resolve_concept(concept, user_id, db)
        if resolved is not None:
            return resolved

    # Stage 6: fallback. Money arriving on a card or a loan pays it down; it
    # is never income. A refund no earlier stage caught reads as a payment.
    if incoming and account_type in DEBT_ACCOUNT_CONCEPTS:
        resolved = await resolve_concept(DEBT_ACCOUNT_CONCEPTS[account_type], user_id, db)
        if resolved is not None:
            return resolved

    txn_type_lower = (transaction_type or "").lower()
    if txn_type_lower == "credit":
        fallback_name = "Other Income"
    elif txn_type_lower == "debit":
        fallback_name = "Other Expenses"
    else:
        fallback_name = "Other Income" if amount >= 0 else "Other Expenses"
    fallback = await _category_by_name(fallback_name, user_id, db)
    if fallback:
        return fallback.id

    # Last resort: if the user deleted the Other buckets, land in Uncategorized
    # rather than returning None (which leaves the txn with no category at all).
    uncategorized = await _category_by_name("Uncategorized", user_id, db)
    if uncategorized:
        return uncategorized.id

    return None

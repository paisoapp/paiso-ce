"""Shared request validation: accuracy, not just syntax.

Pydantic already rejects "banana" for a date. What it happily accepted was a
*real* date that cannot be true — a date of birth of 0001-01-01, a trade
dated next year, a 250% ownership share, a negative share count — which then
flowed into ages, projections and net worth. These annotated types say what a
value must mean, once, so every endpoint that takes one enforces the same
rule and returns the same readable message.

Use them as field types::

    class ProfileUpdateIn(BaseModel):
        dob: AccountHolderBirthDate | None = None
        phone: USPhone | None = None
"""
import math
import re
from datetime import date, timedelta
from typing import Annotated

import phonenumbers
from pydantic import AfterValidator, EmailStr, Field

#: Nothing a user enters for themselves predates this.
EARLIEST_DATE = date(1900, 1, 1)
#: Oldest plausible living person, in years.
MAX_AGE = 120
#: Minimum age to hold a Paiso account.
MIN_ACCOUNT_HOLDER_AGE = 18
#: Money columns are Numeric(18, 2..4); anything near that is a typo or a
#: unit mix-up, not a balance.
MAX_MONEY = 1_000_000_000_000  # $1 trillion


#: Password rules, in one place. Every path that sets a password (sign-up,
#: change, and the CLI reset) enforces exactly these, because a rule applied
#: on some paths only is as weak as its weakest path.
MIN_PASSWORD_LENGTH = 8
#: Argon2 hashes whatever it is given, so an unbounded password is a cheap way
#: to make the server do expensive work. Longer than any real passphrase.
MAX_PASSWORD_LENGTH = 128

#: Rejected outright regardless of length. Not a substitute for a breach
#: check (that needs a network call — see the HIBP follow-up); this only
#: catches the handful that show up first in every spraying list.
_BANNED_PASSWORDS = frozenset({
    "password", "password1", "password123", "passw0rd", "p@ssw0rd",
    "12345678", "123456789", "1234567890", "qwertyui", "qwerty123",
    "iloveyou", "sunshine", "princess", "football", "baseball",
    "welcome1", "welcome123", "admin123", "letmein1", "letmein123",
    "abc12345", "monkey123", "trustno1", "dragon123", "changeme",
    "paiso123", "paisoapp",
})


def password_problem(password: str, email: str | None = None) -> str | None:
    """Why this password is unacceptable, or None if it is fine.

    Returns a message rather than raising so both the API layer (400) and any
    future form-level validation can share one rule set.
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters"
    if not password.strip():
        return "Password cannot be only spaces"
    folded = password.strip().lower()
    if folded in _BANNED_PASSWORDS:
        return "That password is too common. Please choose another."
    if email:
        local = email.split("@")[0].strip().lower()
        if folded == email.strip().lower() or (len(local) >= 4 and folded == local):
            return "Password cannot be your email address"
    return None


def _age_on(dob: date, today: date) -> int:
    return today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))


def _years_ago(years: int, today: date) -> date:
    try:
        return today.replace(year=today.year - years)
    except ValueError:  # 29 Feb in a non-leap target year
        return today.replace(year=today.year - years, day=28)


def _fmt(d: date) -> str:
    return d.strftime("%b %-d, %Y")


# ── Dates ───────────────────────────────────────────────────────────────────

def check_birth_date(v: date, *, min_age: int = 0) -> date:
    today = date.today()
    if v > today:
        raise ValueError("Date of birth can't be in the future.")
    if v < _years_ago(MAX_AGE, today) or v < EARLIEST_DATE:
        raise ValueError(f"Date of birth must be within the last {MAX_AGE} years.")
    if min_age and _age_on(v, today) < min_age:
        raise ValueError(f"You must be at least {min_age} years old to use Paiso.")
    return v


def check_past_date(v: date) -> date:
    """Something that has already happened: a trade, a balance, a payment.

    One day of grace absorbs the user being a timezone ahead of the server.
    """
    if v < EARLIEST_DATE:
        raise ValueError(f"Dates before {EARLIEST_DATE.year} aren't supported.")
    if v > date.today() + timedelta(days=1):
        raise ValueError(f"{_fmt(v)} is in the future — this date must be today or earlier.")
    return v


def check_reasonable_date(v: date) -> date:
    """A date that may lie ahead, within reason: a scheduled transaction, a
    payment due date, a loan's maturity."""
    if v < EARLIEST_DATE:
        raise ValueError(f"Dates before {EARLIEST_DATE.year} aren't supported.")
    if v.year > date.today().year + 100:
        raise ValueError(f"{_fmt(v)} is more than 100 years away.")
    return v


def check_transaction_date(v: date) -> date:
    """A ledger date: in the past, or a year out at most (a scheduled bill)."""
    if v < EARLIEST_DATE:
        raise ValueError(f"Dates before {EARLIEST_DATE.year} aren't supported.")
    if v > date.today() + timedelta(days=366):
        raise ValueError(f"{_fmt(v)} is more than a year away.")
    return v


#: The person signing up / editing their own profile.
AccountHolderBirthDate = Annotated[
    date, AfterValidator(lambda v: check_birth_date(v, min_age=MIN_ACCOUNT_HOLDER_AGE))
]
#: Any other date of birth.
BirthDate = Annotated[date, AfterValidator(check_birth_date)]
PastDate = Annotated[date, AfterValidator(check_past_date)]
ReasonableDate = Annotated[date, AfterValidator(check_reasonable_date)]
TransactionDate = Annotated[date, AfterValidator(check_transaction_date)]


# ── Numbers ─────────────────────────────────────────────────────────────────

def _finite(v: float) -> float:
    if v is None:
        return v
    if not math.isfinite(v):
        raise ValueError("Enter a number.")
    return v


def finite_amount(v: float) -> float:
    """A number read from an imported file, checked before it reaches the
    database: finite and no larger than MAX_MONEY.

    float() happily reads "NaN", "inf" and "1e309". Postgres and SQLite then
    either store infinity, which breaks every total and JSON response, or
    refuse NaN in a NOT NULL column and fail the whole import. Raises
    ValueError, which every parser already treats as an unreadable cell."""
    if not math.isfinite(v):
        raise ValueError("not a finite number")
    if abs(v) > MAX_MONEY:
        raise ValueError("number too large")
    return v


def _money(v: float) -> float:
    _finite(v)
    if abs(v) > MAX_MONEY:
        raise ValueError("That amount is too large. Check for extra digits.")
    return v


def _cents(v: float) -> float:
    """A balance or an amount is kept to the cent: -5000.129 was stored as
    typed and then shown as -$5,000.13 everywhere but the edit box."""
    return v if v is None else round(v, 2)


#: Any signed amount (a transaction, a balance that can go negative), to the cent.
Money = Annotated[float, AfterValidator(_money), AfterValidator(_cents)]
#: A price, value, principal, or payment — never below zero.
NonNegativeMoney = Annotated[float, Field(ge=0), AfterValidator(_money)]
#: What something is worth or cost: a home, a car, a purchase price. Zero is
#: no value at all, so it is refused along with negatives.
PositiveMoney = Annotated[float, Field(gt=0), AfterValidator(_money)]
#: Share / unit counts. Zero is allowed (a fully sold position).
Quantity = Annotated[float, Field(ge=0, le=1_000_000_000), AfterValidator(_finite)]
#: A whole-number percentage, 0–100 (ownership share, APR, allocation).
Percent = Annotated[float, Field(ge=0, le=100), AfterValidator(_finite)]
#: A rate expressed as a fraction (0.07 = 7%): returns, inflation, tax.
Rate = Annotated[float, Field(ge=-1, le=1), AfterValidator(_finite)]
#: A fund expense ratio as a **percent** (0.03 = 0.03%). Real funds sit
#: well under 3%; 10% leaves room for oddities without admitting 100× typos.
ExpenseRatioPct = Annotated[float, Field(ge=0, le=10), AfterValidator(_finite)]
#: A fund expense ratio as a **fraction** (0.0003 = 0.03%) — 529 / trackers.
ExpenseRatioFraction = Annotated[float, Field(ge=0, le=0.1), AfterValidator(_finite)]
#: A person's age in years.
Age = Annotated[int, Field(ge=0, le=MAX_AGE)]
#: A loan / plan term.
TermMonths = Annotated[int, Field(ge=1, le=600)]


# ── Phone numbers ───────────────────────────────────────────────────────────

def normalize_us_phone(v: str | None) -> str | None:
    """A US phone number in E.164 (``+14155550123``), or None for blank.

    Uses Google's libphonenumber metadata, so "(415) 555-0123",
    "415.555.0123" and "+1 415 555 0123" all normalise to the same value and
    a number that cannot exist (a 555-01xx fiction aside, an unassigned area
    code, the wrong length) is rejected rather than stored.
    """
    if v is None:
        return None
    raw = v.strip()
    if not raw:
        return None
    try:
        num = phonenumbers.parse(raw, "US")
    except phonenumbers.NumberParseException:
        raise ValueError("Enter a valid US phone number, e.g. (415) 555-0123.")
    if not phonenumbers.is_valid_number_for_region(num, "US"):
        raise ValueError("Enter a valid US phone number, e.g. (415) 555-0123.")
    return phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164)


USPhone = Annotated[str, AfterValidator(normalize_us_phone)]


# ── Names ───────────────────────────────────────────────────────────────────

#: Longest account (or asset) name a user can type. A 166-character name
#: pushed the Portfolio tables' balance column off screen; the UI
#: truncates as well, this keeps the stored value sensible.
MAX_ACCOUNT_NAME = 100


def _account_name(v: str) -> str:
    name = v.strip()
    if not name:
        raise ValueError("Enter a name.")
    if len(name) > MAX_ACCOUNT_NAME:
        raise ValueError(f"Keep the name to {MAX_ACCOUNT_NAME} characters or fewer.")
    return name


AccountName = Annotated[str, AfterValidator(_account_name)]


#: A mortgage's description pattern: plain text a bank prints on the
#: payment, such as "JPMORGAN CHASE" or "SQ *EXAMPLE". It is matched with
#: ILIKE, so % and _ (the wildcards) and backslash are not allowed, nor is
#: anything else a bank description does not need.
MAX_DESCRIPTION_PATTERN = 64
_PATTERN_CHARS = re.compile(r"[A-Za-z0-9 &.,'/#()*:+-]+")


def _description_pattern(v: str | None) -> str | None:
    """'' stays '' (an explicit clear); None stays None (not sent)."""
    if v is None:
        return None
    text = " ".join(v.split())
    if not text:
        return ""
    if len(text) > MAX_DESCRIPTION_PATTERN:
        raise ValueError(f"Keep the pattern to {MAX_DESCRIPTION_PATTERN} characters or fewer.")
    if not _PATTERN_CHARS.fullmatch(text):
        raise ValueError(
            "Use letters, numbers, spaces and & . , ' / # ( ) * : + - only."
        )
    return text


DescriptionPattern = Annotated[str | None, AfterValidator(_description_pattern)]


# An email address, normalised to the single canonical form the database stores
# and every lookup compares against: trimmed and lowercased. EmailStr
# only lowercases the domain, so "Foo@x.com" and "foo@x.com" would otherwise be
# two accounts, and a capitalised address would fail to sign in. Use this on
# every auth input (register, login, forgot-password) so there is one spelling.
def _normalize_email(v: str) -> str:
    return v.strip().lower()


NormalizedEmail = Annotated[EmailStr, AfterValidator(_normalize_email)]


#: A category rule's pattern. Rules are regular expressions, run
#: against every imported transaction, so a pattern is kept short and one
#: that can backtrack for a very long time is refused when it is saved. The
#: matcher (app/modules/accounts/categorizer.py) also stops any one match
#: after RULE_MATCH_TIMEOUT_SECS, for patterns saved before this check.
MAX_RULE_PATTERN = 200
RULE_MATCH_TIMEOUT_SECS = 0.05

# A group that repeats (+, *, {n,}) and holds a repeat or an alternative of
# its own, such as (a+)+ or (a|aa)*: the classic shapes that backtrack
# exponentially. Ordinary rules ("AMAZON|AMZN", "UBER\s+EATS") never need it.
_NESTED_REPEAT = re.compile(r"\((?:[^()\\]|\\.)*(?:[+*}]|\|)(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)")


def _rule_pattern(v: str) -> str:
    import regex

    text = v.strip()
    if not text:
        raise ValueError("Enter the text or pattern to match.")
    if len(text) > MAX_RULE_PATTERN:
        raise ValueError(f"Keep the pattern to {MAX_RULE_PATTERN} characters or fewer.")
    try:
        regex.compile(text)
    except regex.error:
        raise ValueError("This pattern is not a valid regular expression.")
    if _NESTED_REPEAT.search(text):
        raise ValueError(
            "Simplify the pattern: a repeated group that holds its own repeat or "
            "alternatives can take too long to match."
        )
    return text


RulePattern = Annotated[str, AfterValidator(_rule_pattern)]

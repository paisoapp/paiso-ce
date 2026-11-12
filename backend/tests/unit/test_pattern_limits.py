"""User-supplied patterns are bounded."""
import pytest
from pydantic import BaseModel, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

import app.models  # noqa: F401
from app.core.database import Base
from app.core.validation import (
    MAX_DESCRIPTION_PATTERN,
    MAX_RULE_PATTERN,
    DescriptionPattern,
    RulePattern,
)
from app.models.transaction import Transaction

pytestmark = pytest.mark.unit


class _Body(BaseModel):
    description_pattern: DescriptionPattern = None


def _pattern(value):
    return _Body(description_pattern=value).description_pattern


# ── description_pattern ───────────────────────────────────────────────────

@pytest.mark.parametrize("value, stored", [
    ("JPMORGAN CHASE", "JPMORGAN CHASE"),
    ("  Example  Servicer  ", "Example Servicer"),
    ("SQ *EXAMPLE", "SQ *EXAMPLE"),
    ("EXAMPLE HOME MTG #1234", "EXAMPLE HOME MTG #1234"),
    ("", ""),
    ("   ", ""),
    (None, None),
])
def test_bank_text_is_accepted(value, stored):
    assert _pattern(value) == stored


@pytest.mark.parametrize("value", [
    "%", "100%", "A_B", "back\\slash", "<script>", "a" * (MAX_DESCRIPTION_PATTERN + 1),
])
def test_wildcards_markup_and_long_text_are_refused(value):
    with pytest.raises(ValidationError):
        _pattern(value)


@pytest.mark.asyncio
async def test_a_stored_wildcard_matches_literally(tmp_path):
    """An older pattern may hold % or _; it matches as text."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'p.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with engine.connect() as conn:
        stmt = select(Transaction.id).where(Transaction.description.icontains("%", autoescape=True))
        compiled = str(stmt.compile(compile_kwargs={"literal_binds": True}))
    await engine.dispose()
    assert "ESCAPE" in compiled


# ── category-rule patterns ───────────────────────────────────────────────

class _Rule(BaseModel):
    pattern: RulePattern


@pytest.mark.parametrize("value", [
    "AMAZON", "AMAZON|AMZN", r"UBER\s+EATS", r"^SQ \*", r"PAYROLL \d{4}", "(STARBUCKS|PEETS) COFFEE",
])
def test_ordinary_rules_are_accepted(value):
    assert _Rule(pattern=value).pattern == value


@pytest.mark.parametrize("value", [
    "", "   ", "(unclosed", "a" * (MAX_RULE_PATTERN + 1),
    "(a+)+$", "(a|aa)*", r"(\w+\s?)+$", "(x*){2,}",
])
def test_bad_or_runaway_patterns_are_refused(value):
    with pytest.raises(ValidationError):
        _Rule(pattern=value)


async def _classify_with_rule(tmp_path, pattern, description, *, case_sensitive=False):
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.models.category_rule import CategoryRule
    from app.models.transaction import Category
    from app.models.user import User
    from app.modules.accounts import categorizer

    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'r.db'}")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSession(engine, expire_on_commit=False) as db:
        user = User(email="r@example.com", hashed_password="x", token_family="f")
        db.add(user)
        await db.flush()
        cat = Category(user_id=user.id, name="Rule hit")
        db.add(cat)
        await db.flush()
        # Saved straight to the table, as an older rule would be.
        db.add(CategoryRule(user_id=user.id, pattern=pattern, category_id=cat.id,
                            priority=10, is_case_sensitive=case_sensitive))
        await db.commit()
        got = await categorizer.classify_transaction(description, -5.0, user.id, db)
    await engine.dispose()
    return got, cat.id


@pytest.mark.asyncio
async def test_escapes_keep_their_meaning_when_case_is_ignored(tmp_path):
    """\\d used to be upper-cased into \\D, so this rule never matched."""
    got, cat_id = await _classify_with_rule(tmp_path, r"payroll \d{4}", "PAYROLL 2026 ACME")
    assert got == cat_id


@pytest.mark.asyncio
async def test_a_runaway_rule_saved_earlier_is_skipped_not_stuck(tmp_path):
    got, cat_id = await _classify_with_rule(tmp_path, "(a|aa)+$", "a" * 40 + "!")
    assert got != cat_id

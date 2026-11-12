from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.validation import RulePattern
from app.models.category_rule import CategoryRule
from app.models.transaction import Category
from app.models.user import User
from app.modules.accounts.category_emoji import emoji_for
from app.modules.accounts.seed_categories import seed_default_categories

router = APIRouter(prefix="/api/categories", tags=["categories"])
rules_router = APIRouter(prefix="/api/category-rules", tags=["category-rules"])

# Root branches + the catch-all bucket. These are structural — renaming or
# deleting them would break the income/expense/transfer semantics the rest of
# the app relies on, so they're protected from edit/delete.
PROTECTED_ROOT_NAMES = {"income", "expense", "transfer", "uncategorized"}


def _is_protected_root(cat: Category) -> bool:
    return cat.parent_id is None and cat.name.strip().lower() in PROTECTED_ROOT_NAMES


async def _icons_in_use(db: AsyncSession, user_id: int) -> set[str]:
    return {i for i in (await db.scalars(select(Category.icon).where(Category.user_id == user_id))).all() if i}


# ── Schemas ───────────────────────────────────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str
    is_income: bool = False
    parent_id: int | None = None
    icon: str | None = None
    color: str | None = None
    # A group of the user's own, with how its categories count.
    is_group: bool = False
    treatment: Literal["income", "expense", "transfer"] | None = None


class CategoryUpdate(BaseModel):
    name: str | None = None
    icon: str | None = None
    color: str | None = None


class CategoryOut(BaseModel):
    id: int
    name: str
    is_income: bool
    parent_id: int | None
    icon: str | None
    color: str | None
    treatment: str | None = None
    is_group: bool = False
    position: int = 0

    model_config = {"from_attributes": True}


class CategoryOrder(BaseModel):
    id: int
    position: int = Field(ge=0)


class CategoryMove(BaseModel):
    """Move a category to another group. ``keep`` takes it as it is;
    ``merge`` hands its transactions to a category already in that group and
    deletes it; ``uncategorize`` leaves its transactions without a category
    and deletes it."""
    group_id: int
    mode: Literal["keep", "merge", "uncategorize"] = "keep"
    merge_into_id: int | None = None


class RuleCreate(BaseModel):
    pattern: RulePattern
    match_field: str = "description"
    category_id: int
    priority: int = 0
    is_case_sensitive: bool = False


class RuleUpdate(BaseModel):
    pattern: RulePattern | None = None
    match_field: str | None = None
    category_id: int | None = None
    priority: int | None = None
    is_case_sensitive: bool | None = None


class RuleOut(BaseModel):
    id: int
    pattern: str
    match_field: str
    category_id: int
    priority: int
    is_case_sensitive: bool

    model_config = {"from_attributes": True}


# ── Category endpoints ────────────────────────────────────────────────────────

@router.get("", response_model=list[CategoryOut])
async def list_categories(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.scalars(
        select(Category)
        .where(Category.user_id == user.id)
        .order_by(Category.parent_id.nullsfirst(), Category.position, func.lower(Category.name))
    )).all()
    # Auto-seed for users who registered before category seeding was added
    if not rows:
        await seed_default_categories(user.id, db)
        await db.commit()
        rows = (await db.scalars(
            select(Category)
            .where(Category.user_id == user.id)
            .order_by(Category.parent_id.nullsfirst(), Category.position, func.lower(Category.name))
        )).all()
    return rows


@router.get("/emoji")
async def suggest_emoji(
    name: str = "",
    is_group: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The emoji a new category or group called `name` would get, for the
    form's preview while the name is typed."""
    return {"emoji": emoji_for(name, is_group=is_group, avoid=await _icons_in_use(db, user.id))}


@router.post("/reset-to-defaults", status_code=200)
async def reset_categories_to_defaults(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Hard-reset: clear all categories for this user and re-seed defaults.
    Transactions are set to uncategorized so they can be re-categorized."""
    from sqlalchemy import text as sql_text
    # Detach transactions from categories (set to NULL) so FK constraint allows
    # deletion. The transaction table has no user_id column — it is scoped to the
    # user through its account.
    await db.execute(
        sql_text(
            'UPDATE "transaction" SET category_id = NULL '
            'WHERE account_id IN (SELECT id FROM account WHERE user_id = :uid)'
        ),
        {"uid": user.id},
    )
    # Delete all category rules first (FK → category)
    await db.execute(
        sql_text("DELETE FROM category_rule WHERE user_id = :uid"),
        {"uid": user.id},
    )
    # Delete all categories
    await db.execute(
        sql_text("DELETE FROM category WHERE user_id = :uid"),
        {"uid": user.id},
    )
    await db.commit()
    await seed_default_categories(user.id, db)
    await db.commit()
    return {"ok": True}


@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(
    body: CategoryCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    parent = None
    if body.parent_id is not None:
        parent = await db.scalar(
            select(Category).where(Category.id == body.parent_id, Category.user_id == user.id)
        )
        if not parent:
            raise HTTPException(status_code=404, detail="Parent category not found")

    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Give it a name.")
    if body.is_group:
        if parent is not None:
            raise HTTPException(status_code=400, detail="A group cannot go inside another group.")
        if body.treatment is None:
            raise HTTPException(status_code=422, detail="Choose how the group counts: income, expense or transfer.")
        if name.lower() in PROTECTED_ROOT_NAMES:
            raise HTTPException(status_code=400, detail="That name is taken by a built-in group.")
    elif parent is not None and not parent.is_group:
        # Groups hold categories; a category does not hold more.
        raise HTTPException(status_code=400, detail="A category goes inside a group.")

    cat = Category(user_id=user.id, **body.model_dump(exclude={"treatment", "name"}))
    cat.name = name
    if body.is_group:
        cat.treatment = body.treatment
        cat.is_income = body.treatment == "income"
    else:
        # Inherit budgeting treatment from the parent; otherwise derive from is_income
        # so custom categories are always classified (never NULL → fall through to sign).
        cat.treatment = (parent.treatment if parent else None) or ("income" if cat.is_income else "expense")
        if parent is not None:
            cat.is_income = parent.is_income
    cat.icon = body.icon or emoji_for(name, is_group=body.is_group, avoid=await _icons_in_use(db, user.id))
    last = await db.scalar(
        select(func.max(Category.position)).where(
            Category.user_id == user.id,
            Category.parent_id.is_(None) if parent is None else Category.parent_id == parent.id,
        )
    )
    cat.position = (last or 0) + 1
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return cat


@router.patch("/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: int,
    body: CategoryUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cat = await db.scalar(
        select(Category).where(Category.id == category_id, Category.user_id == user.id)
    )
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    # Allow recolor/icon changes on root branches, but never let them be renamed.
    if _is_protected_root(cat) and body.name is not None and body.name.strip().lower() != cat.name.lower():
        raise HTTPException(status_code=400, detail="Built-in categories cannot be renamed")
    for field, value in body.model_dump(exclude_none=True).items():
        setattr(cat, field, value)
    await db.commit()
    await db.refresh(cat)
    return cat


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    cat = await db.scalar(
        select(Category).where(Category.id == category_id, Category.user_id == user.id)
    )
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    if _is_protected_root(cat):
        raise HTTPException(status_code=400, detail="Income, Expense and Transfer are built in and cannot be deleted.")
    # Block deleting a branch that still has children — would orphan them.
    child_count = await db.scalar(
        select(func.count()).select_from(Category).where(Category.parent_id == cat.id)
    )
    if child_count:
        raise HTTPException(
            status_code=400,
            detail="Move or delete the categories in this group first.",
        )
    # Detach any transactions so the FK constraint allows deletion.
    from sqlalchemy import text as sql_text
    await db.execute(
        sql_text('UPDATE "transaction" SET category_id = NULL WHERE category_id = :cid'),
        {"cid": cat.id},
    )
    await db.execute(
        sql_text("DELETE FROM category_rule WHERE category_id = :cid"),
        {"cid": cat.id},
    )
    await db.delete(cat)
    await db.commit()


@router.put("/order")
async def reorder_categories(
    body: list[CategoryOrder],
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """The order of categories inside one group, after a drag."""
    ids = [item.id for item in body]
    cats = {
        c.id: c for c in (await db.scalars(
            select(Category).where(Category.user_id == user.id, Category.id.in_(ids))
        )).all()
    }
    if len(cats) != len(set(ids)):
        raise HTTPException(status_code=404, detail="Category not found")
    if len({c.parent_id for c in cats.values()}) > 1:
        raise HTTPException(status_code=400, detail="Reorder one group at a time.")
    for item in body:
        cats[item.id].position = item.position
    await db.commit()
    return {"ok": True}


def _user_transactions(user_id: int):
    from app.models.account import Account
    from app.models.transaction import Transaction

    return Transaction.account_id.in_(select(Account.id).where(Account.user_id == user_id))


@router.get("/{category_id}/impact")
async def category_impact(
    category_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """What a move to another group would touch, for its confirm step."""
    from app.models.budget import Budget, BudgetLine
    from app.models.transaction import Transaction

    cat = await db.scalar(select(Category).where(Category.id == category_id, Category.user_id == user.id))
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    transactions = await db.scalar(
        select(func.count()).select_from(Transaction)
        .where(Transaction.category_id == category_id, _user_transactions(user.id))
    )
    rules = await db.scalar(
        select(func.count()).select_from(CategoryRule).where(CategoryRule.category_id == category_id)
    )
    budgets = (await db.scalars(
        select(Budget.name).join(BudgetLine, BudgetLine.budget_id == Budget.id)
        .where(BudgetLine.category_id == category_id, BudgetLine.hidden.is_(False), Budget.user_id == user.id)
        .order_by(Budget.id)
    )).all()
    return {"transactions": transactions or 0, "rules": rules or 0, "budgets": list(budgets)}


async def _remove_from_budgets(db: AsyncSession, user_id: int, category_id: int) -> None:
    """Hide a category's budget lines from this month on, keeping the months
    before, as Remove from budget does on the Budget tab."""
    from app.api.budget import _first_of_this_month, _hide_from
    from app.models.budget import Budget, BudgetLine
    from app.modules.budgeting.plan import load_amount_history

    rows = (await db.execute(
        select(BudgetLine, Budget).join(Budget, Budget.id == BudgetLine.budget_id)
        .where(BudgetLine.category_id == category_id, BudgetLine.user_id == user_id)
    )).all()
    history = await load_amount_history(db, [line for line, _b in rows])
    for line, budget in rows:
        if line.hidden:
            continue
        month = max(_first_of_this_month(), budget.start_month)
        await _hide_from(db, line, history.setdefault(line.id, []), month, budget.start_month)


async def _place_in_group(db: AsyncSession, cat: Category, group_id: int, last: int | None) -> None:
    """Where a category moved into a group goes. A group still
    in name order takes it in name order, so moving one out and back puts it
    where it was; a group the user has reordered gets it at the end."""
    siblings = list((await db.scalars(
        select(Category).where(Category.parent_id == group_id, Category.id != cat.id).order_by(Category.position)
    )).all())
    names = [c.name.lower() for c in siblings]
    if names != sorted(names):
        cat.position = (last or 0) + 1
        return
    ordered = sorted([*siblings, cat], key=lambda c: c.name.lower())
    for i, c in enumerate(ordered):
        c.position = i


@router.post("/{category_id}/move")
async def move_category(
    category_id: int,
    body: CategoryMove,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Move a category to another group, in one of three ways (see
    ``CategoryMove``). Its transactions count the way the new group counts
    from then on, past months included; a budget line it can no longer carry
    leaves the budget from this month."""
    from app.models.budget import BudgetLine, BudgetLineAmount
    from app.models.transaction import Transaction
    from app.modules.budgeting.benchmarks import is_budgetable

    cat = await db.scalar(select(Category).where(Category.id == category_id, Category.user_id == user.id))
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")
    if cat.is_group or _is_protected_root(cat):
        raise HTTPException(status_code=400, detail="Only a category can be moved, not a group.")
    group = await db.scalar(select(Category).where(Category.id == body.group_id, Category.user_id == user.id))
    if not group or not group.is_group:
        raise HTTPException(status_code=404, detail="Group not found")
    if group.id == cat.parent_id:
        raise HTTPException(status_code=400, detail="It is already in that group.")
    last = await db.scalar(select(func.max(Category.position)).where(Category.parent_id == group.id))

    if body.mode == "keep":
        cat.parent_id = group.id
        cat.treatment = group.treatment
        cat.is_income = group.is_income
        await _place_in_group(db, cat, group.id, last)
        if not is_budgetable(cat.name, cat.treatment):
            await _remove_from_budgets(db, user.id, cat.id)
        await db.commit()
        return {"ok": True, "category_id": cat.id}

    target = None
    if body.mode == "merge":
        target = await db.scalar(
            select(Category).where(Category.id == body.merge_into_id, Category.user_id == user.id)
        )
        if not target or target.parent_id != group.id:
            raise HTTPException(status_code=404, detail="Choose a category in that group.")

    await db.execute(
        update(Transaction)
        .where(Transaction.category_id == cat.id, _user_transactions(user.id))
        .values(category_id=target.id if target else None)
        .execution_options(synchronize_session=False)
    )
    if target:
        await db.execute(update(CategoryRule).where(CategoryRule.category_id == cat.id).values(category_id=target.id))
    else:
        await db.execute(delete(CategoryRule).where(CategoryRule.category_id == cat.id))

    # Budget lines: a merge hands each line to the target where the budget has
    # none for it, keeping its history; otherwise the line goes with the category.
    lines = (await db.scalars(select(BudgetLine).where(BudgetLine.category_id == cat.id))).all()
    for line in lines:
        taken = target is not None and await db.scalar(
            select(BudgetLine.id).where(BudgetLine.budget_id == line.budget_id, BudgetLine.category_id == target.id)
        )
        if target is not None and not taken:
            line.category_id = target.id
            continue
        await db.execute(delete(BudgetLineAmount).where(BudgetLineAmount.budget_line_id == line.id))
        await db.delete(line)
    await db.flush()
    if target is not None and not is_budgetable(target.name, target.treatment):
        await _remove_from_budgets(db, user.id, target.id)
    await db.delete(cat)
    await db.commit()
    return {"ok": True, "category_id": target.id if target else None}


# ── Category rule endpoints ───────────────────────────────────────────────────

@rules_router.get("", response_model=list[RuleOut])
async def list_rules(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rows = (await db.scalars(
        select(CategoryRule)
        .where(CategoryRule.user_id == user.id)
        .order_by(CategoryRule.priority.desc())
    )).all()
    return rows


@rules_router.post("", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
async def create_rule(
    body: RuleCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # Verify category belongs to user
    cat = await db.scalar(
        select(Category).where(Category.id == body.category_id, Category.user_id == user.id)
    )
    if not cat:
        raise HTTPException(status_code=404, detail="Category not found")

    rule = CategoryRule(user_id=user.id, **body.model_dump())
    db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return rule


@rules_router.patch("/{rule_id}", response_model=RuleOut)
async def update_rule(
    rule_id: int,
    body: RuleUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = await db.scalar(
        select(CategoryRule).where(CategoryRule.id == rule_id, CategoryRule.user_id == user.id)
    )
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    updated = body.model_dump(exclude_none=True)
    # Guard against IDOR: a re-pointed category must belong to the caller.
    if updated.get("category_id") is not None:
        cat = await db.scalar(
            select(Category).where(
                Category.id == updated["category_id"], Category.user_id == user.id
            )
        )
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
    for field, value in updated.items():
        setattr(rule, field, value)
    await db.commit()
    await db.refresh(rule)
    return rule


@rules_router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    rule = await db.scalar(
        select(CategoryRule).where(CategoryRule.id == rule_id, CategoryRule.user_id == user.id)
    )
    if not rule:
        raise HTTPException(status_code=404, detail="Rule not found")
    await db.delete(rule)
    await db.commit()

"""Budget aggregation queries — expenses, income, cash flow.

Income  = money in (amount > 0), except a refund: money in under an
           expense category.
Expenses = money out (amount < 0) net of refunds, per category. A refund
           undoes part of a purchase, as the Budget tab already counts it
           (``_category_spend_totals`` in ``plan.py``). A user who sees a refund
           as income moves it to an income category; one who sees it as money
           coming back moves it to Refunds, a transfer category.
Cash Flow = the same split, day by day.
"""
from datetime import date, timedelta
from typing import Optional

from sqlalchemy import and_, case, func, not_, or_, select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.transaction import Category, Transaction


async def _get_account_ids(
    db: AsyncSession,
    user_id: int,
    account_id: Optional[int] = None,
) -> list[int]:
    q = select(Account.id).where(Account.user_id == user_id)
    if account_id is not None:
        q = q.where(Account.id == account_id)
    return list((await db.scalars(q)).all())


#: Unsettled transactions are visible in the ledger but must not move any
#: total. Pending amounts are routinely wrong — a fuel hold is $1 or
#: $100, a restaurant tip settles higher — so counting them would make budgets
#: and cash flow wrong for 1-3 days and then silently correct themselves.
#: Rows predating the column are NULL, hence `is_not(True)` rather than
#: `== False`.
_NOT_PENDING = Transaction.pending.is_not(True)

#: Account types that are a loan's own ledger.
LOAN_ACCOUNT_TYPES = ("loan", "mortgage")

# Money coming in on a loan or mortgage account is the loan's side of a
# payment made from another account ("PRINCIPAL PAYMENT +$200" for a $3,200
# mortgage payment from checking). It is never a refund or income, so it is
# left out wherever spending or income is summed: counted, it cut the
# Mortgage category's spending by the principal and showed it as income
# every month.
_NOT_LOAN_CREDIT = or_(
    Transaction.amount <= 0,
    Transaction.account_id.notin_(
        select(Account.id).where(Account.account_type.in_(LOAN_ACCOUNT_TYPES)).scalar_subquery()
    ),
)


def _expense_cat_ids_subq(user_id: int):
    """Scalar subquery returning the category IDs whose treatment is 'expense'."""
    return (
        select(Category.id)
        .where(Category.user_id == user_id, Category.treatment == "expense")
        .scalar_subquery()
    )


def _is_refund(user_id: int):
    """Money in under an expense category: a refund, netted against that
    category's spending and never counted as income."""
    # The NULL check keeps it false, not NULL, for an uncategorized row, so
    # ``not_()`` of it holds there.
    return and_(
        Transaction.amount > 0,
        Transaction.category_id.is_not(None),
        Transaction.category_id.in_(_expense_cat_ids_subq(user_id)),
    )


def _side(income: bool, user_id: int):
    """The rows one side of the Income / Expenses split sums."""
    if income:
        return and_(Transaction.amount > 0, not_(_is_refund(user_id)))
    return or_(Transaction.amount < 0, _is_refund(user_id))


def _transfer_cat_ids_subq(user_id: int):
    """Scalar subquery returning all category IDs treated as transfers for a user.

    A transfer is any net-worth-neutral movement (account-to-account moves,
    credit-card payments, security buys/sells, refunds, reimbursements). These
    are flagged by Category.treatment == 'transfer' and excluded from income and
    expense totals.  Classification is driven by the category's treatment field
    rather than its name, so renaming a category never changes the math.
    """
    return (
        select(Category.id)
        .where(Category.user_id == user_id, Category.treatment == "transfer")
        .scalar_subquery()
    )


async def _category_totals(
    db: AsyncSession,
    user_acct_ids: list[int],
    date_from: Optional[date],
    date_to: Optional[date],
    income: bool,
    user_id: int,
) -> list[dict]:
    """Return per-category totals for the given period, split by amount sign.

    Income  (income=True)  → money in, refunds left out.
    Expenses (income=False) → money out net of refunds. A category whose
    refunds match or outweigh its purchases in the period is left out, as the
    Budget tab clips it at zero.
    Transfer-tree categories are excluded from both income and expense totals.
    Only categories that have transactions in this period are returned.
    """
    amount_cond = _side(income, user_id)

    where_clauses = [
        Transaction.account_id.in_(user_acct_ids),
        amount_cond,
        _NOT_PENDING,
        _NOT_LOAN_CREDIT,
        # Exclude all Transfer-tree categories (root + children)
        Category.id.notin_(_transfer_cat_ids_subq(user_id)),
    ]
    if date_from is not None:
        where_clauses.append(Transaction.date_posted >= date_from)
    if date_to is not None:
        where_clauses.append(Transaction.date_posted <= date_to)

    rows = (await db.execute(
        select(
            Category.id,
            Category.name,
            Category.color,
            Category.parent_id,
            func.sum(Transaction.amount).label("total"),
            func.count(Transaction.id).label("count"),
        )
        .join(Transaction, Transaction.category_id == Category.id)
        .where(*where_clauses)
        .group_by(Category.id, Category.name, Category.color, Category.parent_id)
        .order_by(func.abs(func.sum(Transaction.amount)).desc())
    )).all()

    return [
        {
            "category_id": r.id,
            "category_name": r.name,
            "color": r.color,
            "parent_id": r.parent_id,
            "total": float(r.total),
            "count": r.count,
        }
        for r in rows
        if income or r.total < 0
    ]


async def _uncategorized_total(
    db: AsyncSession,
    user_acct_ids: list[int],
    date_from: Optional[date],
    date_to: Optional[date],
    income: bool,
) -> dict | None:
    amount_cond = Transaction.amount > 0 if income else Transaction.amount < 0

    where_clauses = [
        Transaction.account_id.in_(user_acct_ids),
        Transaction.category_id.is_(None),
        amount_cond,
        _NOT_PENDING,
        _NOT_LOAN_CREDIT,
    ]
    if date_from is not None:
        where_clauses.append(Transaction.date_posted >= date_from)
    if date_to is not None:
        where_clauses.append(Transaction.date_posted <= date_to)

    result = await db.execute(
        select(
            func.sum(Transaction.amount).label("total"),
            func.count(Transaction.id).label("count"),
        )
        .where(*where_clauses)
    )
    row = result.one()
    if not row.count:
        return None
    return {
        "category_id": None,
        "category_name": "Uncategorized",
        "color": "#94a3b8",
        "parent_id": None,
        "total": float(row.total),
        "count": row.count,
    }


async def get_expenses(
    db: AsyncSession,
    user_id: int,
    date_from: Optional[date],
    date_to: Optional[date],
    compare_from: Optional[date] = None,
    compare_to: Optional[date] = None,
    account_id: Optional[int] = None,
) -> dict:
    acct_ids = await _get_account_ids(db, user_id, account_id)
    rows = await _category_totals(db, acct_ids, date_from, date_to, income=False, user_id=user_id)
    uncat = await _uncategorized_total(db, acct_ids, date_from, date_to, income=False)
    if uncat:
        rows.append(uncat)

    total = sum(r["total"] for r in rows)

    compare = None
    if compare_from and compare_to:
        crows = await _category_totals(db, acct_ids, compare_from, compare_to, income=False, user_id=user_id)
        cuncat = await _uncategorized_total(db, acct_ids, compare_from, compare_to, income=False)
        if cuncat:
            crows.append(cuncat)
        compare = {
            "by_category": crows,
            "total": sum(r["total"] for r in crows),
        }

    period_from = date_from.isoformat() if date_from else None
    period_to = date_to.isoformat() if date_to else None
    return {
        "period": {"from": period_from, "to": period_to},
        "by_category": rows,
        "total": total,
        "compare": compare,
    }


async def get_income(
    db: AsyncSession,
    user_id: int,
    date_from: Optional[date],
    date_to: Optional[date],
    compare_from: Optional[date] = None,
    compare_to: Optional[date] = None,
    account_id: Optional[int] = None,
) -> dict:
    acct_ids = await _get_account_ids(db, user_id, account_id)
    rows = await _category_totals(db, acct_ids, date_from, date_to, income=True, user_id=user_id)
    uncat = await _uncategorized_total(db, acct_ids, date_from, date_to, income=True)
    if uncat:
        rows.append(uncat)
    # The Sankey's third branch. Same scope and filters as `by_category` above,
    # so the two always sum to the same total.

    total = sum(r["total"] for r in rows)

    compare = None
    if compare_from and compare_to:
        crows = await _category_totals(db, acct_ids, compare_from, compare_to, income=True, user_id=user_id)
        cuncat = await _uncategorized_total(db, acct_ids, compare_from, compare_to, income=True)
        if cuncat:
            crows.append(cuncat)
        compare = {
            "by_category": crows,
            "total": sum(r["total"] for r in crows),
        }

    period_from = date_from.isoformat() if date_from else None
    period_to = date_to.isoformat() if date_to else None
    return {
        "period": {"from": period_from, "to": period_to},
        "by_category": rows,
        "total": total,
        "compare": compare,
    }


async def get_transfers(
    db: AsyncSession,
    user_id: int,
    date_from: Optional[date],
    date_to: Optional[date],
    account_id: Optional[int] = None,
) -> dict:
    """Per-category net for transfer-treatment categories, plus in/out totals.

    Transfers are net-worth-neutral and mixed-sign, so (unlike income/expense)
    each category carries a signed net — positive = money in, negative = out.
    Drives the Transfers tab's in/out summary and diverging net-by-category bar.
    """
    acct_ids = await _get_account_ids(db, user_id, account_id)

    where_clauses = [
        Transaction.account_id.in_(acct_ids),
        Category.treatment == "transfer",
        _NOT_PENDING,
    ]
    if date_from is not None:
        where_clauses.append(Transaction.date_posted >= date_from)
    if date_to is not None:
        where_clauses.append(Transaction.date_posted <= date_to)

    rows = (await db.execute(
        select(
            Category.id,
            Category.name,
            Category.color,
            func.sum(Transaction.amount).label("net"),
            func.sum(case((Transaction.amount > 0, Transaction.amount), else_=0)).label("inflow"),
            func.sum(case((Transaction.amount < 0, Transaction.amount), else_=0)).label("outflow"),
            func.count(Transaction.id).label("count"),
        )
        .join(Transaction, Transaction.category_id == Category.id)
        .where(*where_clauses)
        .group_by(Category.id, Category.name, Category.color)
        .order_by(func.sum(Transaction.amount).desc())
    )).all()

    by_category = [
        {
            "category_id": r.id,
            "category_name": r.name,
            "color": r.color,
            "net": float(r.net or 0),
            "inflow": float(r.inflow or 0),
            "outflow": float(r.outflow or 0),
            "count": r.count,
        }
        for r in rows
    ]

    total_in = sum(c["inflow"] for c in by_category)
    total_out = sum(c["outflow"] for c in by_category)

    # A confirmed pair is one movement seen twice. Reporting it as both $500 in
    # and $500 out doubles the apparent volume of money moved — the per-category
    # rows above are left untouched (they are a ledger breakdown), but the
    # headline in/out figures net the pairs out.
    paired = await _paired_transfer_total(db, user_id, acct_ids, date_from, date_to)

    period_from = date_from.isoformat() if date_from else None
    period_to = date_to.isoformat() if date_to else None
    return {
        "period": {"from": period_from, "to": period_to},
        "by_category": by_category,
        "total_in": total_in,
        "total_out": total_out,
        "total_net": total_in + total_out,
        # Both legs of each confirmed pair are inside total_in/total_out above.
        "paired_amount": paired["amount"],
        "paired_count": paired["count"],
        "unpaired_in": round(total_in - paired["amount"], 2),
        "unpaired_out": round(total_out + paired["amount"], 2),
    }


async def _paired_transfer_total(
    db: AsyncSession,
    user_id: int,
    acct_ids: list[int],
    date_from: Optional[date],
    date_to: Optional[date],
) -> dict:
    """Total value of confirmed transfer pairs fully inside this period.

    Only pairs whose *both* legs fall in the window are netted: a payment that
    straddles the boundary genuinely is a one-sided movement as far as this
    period is concerned.
    """
    from app.models.transfer import TransferLink

    outflow = aliased(Transaction)
    inflow = aliased(Transaction)
    clauses = [
        TransferLink.user_id == user_id,
        TransferLink.status == "confirmed",
        outflow.account_id.in_(acct_ids),
        inflow.account_id.in_(acct_ids),
    ]
    if date_from is not None:
        clauses += [outflow.date_posted >= date_from, inflow.date_posted >= date_from]
    if date_to is not None:
        clauses += [outflow.date_posted <= date_to, inflow.date_posted <= date_to]

    row = (await db.execute(
        select(
            func.coalesce(func.sum(TransferLink.amount), 0).label("amount"),
            func.count(TransferLink.id).label("count"),
        )
        .join(outflow, outflow.id == TransferLink.outflow_txn_id)
        .join(inflow, inflow.id == TransferLink.inflow_txn_id)
        .where(*clauses)
    )).one()
    return {"amount": float(row.amount or 0), "count": int(row.count or 0)}


async def get_cashflow(
    db: AsyncSession,
    user_id: int,
    date_from: Optional[date],
    date_to: Optional[date],
    compare_from: Optional[date] = None,
    compare_to: Optional[date] = None,
    account_id: Optional[int] = None,
) -> dict:
    acct_ids = await _get_account_ids(db, user_id, account_id)
    series = await _daily_cashflow(db, acct_ids, date_from, date_to, user_id=user_id)
    compare_series = None
    if compare_from and compare_to:
        compare_series = await _daily_cashflow(db, acct_ids, compare_from, compare_to, user_id=user_id)

    period_from = date_from.isoformat() if date_from else None
    period_to = date_to.isoformat() if date_to else None
    return {
        "period": {"from": period_from, "to": period_to},
        "series": series,
        "compare_series": compare_series,
    }


async def _daily_cashflow(
    db: AsyncSession,
    user_acct_ids: list[int],
    date_from: Optional[date],
    date_to: Optional[date],
    user_id: int = 0,
) -> list[dict]:
    """Daily income/expense/net series, transfer categories excluded (matches Income/Expense page totals).

    Uses SQLAlchemy's case() construct (not func.case) for conditional aggregation.
    When date_from/date_to are None, all transactions are included (no date filter).
    """
    refund = _is_refund(user_id)
    where_clauses = [
        Transaction.account_id.in_(user_acct_ids),
        _NOT_PENDING,
        _NOT_LOAN_CREDIT,
        # Exclude transfers (same logic as _category_totals) so Cash Flow totals match
        # Income/Expense page totals.  Uncategorized (NULL category_id) are kept.
        or_(
            Transaction.category_id.is_(None),
            Transaction.category_id.notin_(_transfer_cat_ids_subq(user_id)),
        ),
    ]
    if date_from is not None:
        where_clauses.append(Transaction.date_posted >= date_from)
    if date_to is not None:
        where_clauses.append(Transaction.date_posted <= date_to)

    rows = (await db.execute(
        select(
            Transaction.date_posted,
            # A refund lowers the day's expenses instead of adding income,
            # as on the Income and Expenses tabs.
            func.sum(
                case(
                    (refund, 0),
                    (Transaction.amount > 0, Transaction.amount),
                    else_=0,
                )
            ).label("income"),
            func.sum(
                case(
                    (refund, Transaction.amount),
                    (Transaction.amount < 0, Transaction.amount),
                    else_=0,
                )
            ).label("expenses"),
        )
        .where(*where_clauses)
        .group_by(Transaction.date_posted)
        .order_by(Transaction.date_posted)
    )).all()

    by_date: dict[date, dict] = {
        r.date_posted: {
            "date": r.date_posted.isoformat(),
            "income": float(r.income or 0),
            "expenses": float(r.expenses or 0),
            "net": float((r.income or 0) + (r.expenses or 0)),
        }
        for r in rows
    }

    # Fill day-by-day gaps only when we have a bounded range
    if date_from is not None and date_to is not None:
        series = []
        cur = date_from
        while cur <= date_to:
            series.append(by_date.get(cur, {
                "date": cur.isoformat(),
                "income": 0.0,
                "expenses": 0.0,
                "net": 0.0,
            }))
            cur += timedelta(days=1)
        return series

    # Unbounded (all-time): return only actual data days, ordered by date
    return list(by_date.values())


async def get_spending_by_day(
    db: AsyncSession,
    user_id: int,
    date_from: date,
    date_to: date,
) -> dict[date, float]:
    """Spending per day between two dates, as positive amounts: the same rows
    ``get_expenses`` totals (money out net of refunds, settled, not in a
    Transfer-tree category, uncategorized included), so a day-by-day line ends
    on the Expenses figure. A day of refunds only comes back negative. Days
    with no spending are left out."""
    acct_ids = await _get_account_ids(db, user_id, None)
    rows = (await db.execute(
        select(Transaction.date_posted, func.sum(Transaction.amount))
        .where(
            Transaction.account_id.in_(acct_ids),
            _side(False, user_id),
            _NOT_PENDING,
            _NOT_LOAN_CREDIT,
            or_(
                Transaction.category_id.is_(None),
                Transaction.category_id.notin_(_transfer_cat_ids_subq(user_id)),
            ),
            Transaction.date_posted >= date_from,
            Transaction.date_posted <= date_to,
        )
        .group_by(Transaction.date_posted)
    )).all()
    return {posted: -float(total) for posted, total in rows if total}

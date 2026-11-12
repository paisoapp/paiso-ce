"""Recording, and reading back, what an account held on a past day."""
import bisect
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.upsert import dialect_insert
from app.models.account_balance import AccountBalanceSnapshot


async def record_balance(
    db: AsyncSession, account_id: int, balance, as_of: date | None = None
) -> None:
    """Note an account's balance as observed on ``as_of`` (today by default).

    A second observation on the same day replaces the first. The caller
    commits, so the note lands or is lost together with the balance itself.
    """
    if balance is None:
        return
    as_of = as_of or date.today()
    await db.execute(
        dialect_insert(AccountBalanceSnapshot)
        .values(account_id=account_id, as_of=as_of, balance=balance)
        .on_conflict_do_update(
            index_elements=["account_id", "as_of"], set_={"balance": balance}
        )
    )


class AmountsByDate:
    """One account's settled transaction amounts, summed over any span of days."""

    def __init__(self, dated_amounts: list[tuple[date, float]]) -> None:
        self._dates: list[date] = []
        self._running: list[float] = []
        total = 0.0
        for when, amount in sorted(dated_amounts, key=lambda p: p[0]):
            total += amount
            self._dates.append(when)
            self._running.append(total)

    def _through(self, day: date) -> float:
        idx = bisect.bisect_right(self._dates, day) - 1
        return self._running[idx] if idx >= 0 else 0.0

    def between(self, after: date, through: date) -> float:
        """Sum of amounts posted after ``after``, up to and including ``through``."""
        return self._through(through) - self._through(after)


def balance_before(
    anchor_date: date, anchor_balance: float, amounts: AmountsByDate, day: date
) -> float:
    """What an account held on ``day``, worked back from a later known balance.

    A balance is the earlier balance plus everything posted since, so the
    earlier one is the later one less those postings. Amounts are signed the
    way the ledger stores them, money in positive, and ``anchor_balance`` must
    be signed the same way (a debt negative).

    Exact when the ledger is complete. A transaction missing from it, or one
    recorded twice, moves every earlier day by its amount.
    """
    return anchor_balance - amounts.between(day, anchor_date)

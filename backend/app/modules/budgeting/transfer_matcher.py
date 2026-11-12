"""Detect the two legs of one money movement and pair them.

Design notes, because the failure mode here is silent and corrosive: a wrong
pair mislabels two real transactions and hides one of them from the user's
spending. Everything below biases toward *not* guessing.

* **A liability corroborates its own payment.** A card or loan can record
  its ``last_payment_amount`` and ``last_payment_date``; a transaction
  matching both confirms the pairing from the other side.
* **Exact amounts only.** No tolerance, no fuzzy matching. Round numbers
  ($100 out of checking, $100 into savings, and a separate $100 card payment
  the same week) are exactly where fuzzy matching invents pairs.
* **Ambiguity loses.** If the two best candidates score within
  :data:`AMBIGUITY_MARGIN` of each other, *neither* is auto-confirmed. Two
  identical $500 payments on the same day is the classic disaster.
* **A positive identification confirms itself.** Auto-confirmation is
  decided by *evidence*, not by a score crossing a line:
  :func:`_positively_identified` names the one shape that qualifies, and
  everything else becomes a suggestion.

The scoring is deliberately legible rather than clever: each signal adds a
fixed amount and ``matched_on`` records which ones fired, so a bad pair can be
explained after the fact.
"""
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

import structlog
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.account_liability import AccountLiability
from app.models.transaction import Category, Transaction
from app.models.transfer import TransferLink
from app.modules.portfolio.valuation import (
    CASH_TYPES, CREDIT_CARD_TYPES, LOAN_TYPES,
)

log = structlog.get_logger()

#: How far apart the two legs may post. Card payments commonly take 2-3 days.
WINDOW_DAYS = 5
#: Below this, not even worth showing.
SUGGEST_THRESHOLD = 0.60
#: Master switch. Off, every pair — however well attested — waits for a human.
#: Kept as a switch so a deployment that wants the queue back can have it.
AUTO_CONFIRM_ENABLED = True
#: The floor a positively-identified pair must still clear. It is not the
#: mechanism — :func:`_positively_identified` is — but a pair carrying real
#: evidence and still scoring this low means something else about it is wrong
#: (both legs hand-entered, a two-week gap), and those are worth a look.
AUTO_CONFIRM_FLOOR = 0.80
#: Two candidates this close are indistinguishable; refuse to pick.
AMBIGUITY_MARGIN = 0.05

_DEBT_TYPES = CREDIT_CARD_TYPES | LOAN_TYPES

#: ``Transaction.amount`` is ``Numeric(18, 4)``, so four decimal places is the
#: full precision the column can hold.
_AMOUNT_QUANTUM = Decimal("0.0001")


def _amount_key(amount) -> str:
    """A hash key for an amount that does not depend on its Decimal scale.

    ``str(abs(amount))`` was the key, and it is not stable: a row loaded from
    the database comes back as ``Decimal("750.0000")`` while one still in the
    session holds ``Decimal("750")``. The two are numerically equal and
    stringify differently, so the exact-amount index silently failed to pair
    them — the legs never met, and the pair was never even scored.

    Quantizing to the column's own scale makes the key depend on the value
    alone. This does not loosen the "exact amounts only" rule: it compares at
    the full precision the column can store.
    """
    return str(abs(Decimal(amount)).quantize(_AMOUNT_QUANTUM))


@dataclass
class Candidate:
    outflow: Transaction
    inflow: Transaction
    score: float
    kind: str
    signals: list[str]
    #: Which positive identification this pair carries, if any — see
    #: :func:`_positively_identified`. This, not the score, is what decides
    #: auto-confirmation.
    identified: str | None = None

    @property
    def matched_on(self) -> str:
        """The audit trail: which signals fired, and which rule confirmed it.

        The identification is appended rather than left implicit, because this
        column is the only thing that explains a bad pair after the fact — and
        "why was this auto-confirmed" is the question that actually gets asked.
        """
        parts = self.signals + ([self.identified] if self.identified else [])
        return "+".join(parts)[:64]

    @property
    def auto_confirms(self) -> bool:
        return (
            AUTO_CONFIRM_ENABLED
            and self.identified is not None
            and self.score >= AUTO_CONFIRM_FLOOR
        )


def _kind_for(outflow_account: Account, inflow_account: Account) -> str:
    if inflow_account.account_type in CREDIT_CARD_TYPES:
        return "credit_card_payment"
    if inflow_account.account_type in LOAN_TYPES:
        return "loan_payment"
    if inflow_account.account_type not in CASH_TYPES:
        return "investment_contribution"
    return "account_transfer"


def _matches_last_payment(inflow: Transaction, liability) -> bool:
    """Does this inflow look like the payment the liability recorded?

    Statement dates and posting dates rarely agree exactly, so a few days of
    slack — but the amount must match to the cent.
    """
    if liability is None or liability.last_payment_amount is None:
        return False
    if abs(abs(inflow.amount) - abs(liability.last_payment_amount)) > Decimal("0.01"):
        return False
    if liability.last_payment_date is None:
        return True
    return abs((inflow.date_posted - liability.last_payment_date).days) <= WINDOW_DAYS


def _score(
    outflow: Transaction,
    inflow: Transaction,
    accounts: dict[int, Account],
    transfer_category_ids: set[int],
    liabilities: dict[int, object],
) -> tuple[float, list[str]]:
    """Score a candidate pair. Amounts are already known to match exactly."""
    score, signals = 0.50, ["amount"]

    delta_days = abs((inflow.date_posted - outflow.date_posted).days)
    if delta_days <= 1:
        score += 0.20
        signals.append(f"{delta_days}d")
    elif delta_days <= 3:
        score += 0.10
        signals.append(f"{delta_days}d")
    else:
        signals.append(f"{delta_days}d")

    outflow_account = accounts.get(outflow.account_id)
    inflow_account = accounts.get(inflow.account_id)
    if outflow_account and inflow_account:
        # Money leaving a spending account to land against a debt is the
        # single most reliable shape a transfer takes.
        if (outflow_account.account_type in CASH_TYPES
                and inflow_account.account_type in _DEBT_TYPES):
            score += 0.15
            signals.append("cash→debt")

    if (_has_transfer_signal(outflow, transfer_category_ids)
            or _has_transfer_signal(inflow, transfer_category_ids)):
        score += 0.15
        signals.append("transfer-signal")

    if inflow_account and _mentions_counterparty(outflow, inflow_account):
        score += 0.10
        signals.append("names-counterparty")

    # The liability itself says what its last payment was and when. A bank
    # transaction of exactly that amount around that date is not a guess.
    if _matches_last_payment(inflow, liabilities.get(inflow.account_id)):
        score += 0.25
        signals.append("liability-last-payment")

    # Two hand-entered rows carry none of the corroboration above; a bare
    # amount-and-date coincidence is not enough to act on.
    if outflow.source == "manual" and inflow.source == "manual":
        score -= 0.30
        signals.append("both-manual")

    return round(max(0.0, min(score, 1.0)), 3), signals


def _refuses_outright(
    outflow: Transaction, inflow: Transaction, accounts: dict[int, Account]
) -> str | None:
    """A reason this pair is not a movement at all, whatever it scores.

    ``debt-to-debt``
        Money does not ordinarily move *from* one credit card or loan to
        another. A card-to-card pair is two unrelated charges that happen to
        match.
    """
    outflow_account = accounts.get(outflow.account_id)
    inflow_account = accounts.get(inflow.account_id)
    if (outflow_account is not None and inflow_account is not None
            and outflow_account.account_type in _DEBT_TYPES
            and inflow_account.account_type in _DEBT_TYPES):
        return "debt-to-debt"
    return None


def _positively_identified(
    outflow: Transaction,
    inflow: Transaction,
    accounts: dict[int, Account],
    liabilities: dict[int, object],
) -> str | None:
    """The signal that makes this pair a fact rather than a guess, or None.

    ``liability-attested``
        The card or loan records its own ``last_payment_amount`` and
        ``last_payment_date``, and a withdrawal matching both is the other
        side confirming the pairing.

    Deliberately excluded: description text naming the counterparty, a bare
    cash→debt account shape, and closeness in time. Each is a reasonable
    *hint* and none is a fact; they raise the score and produce a suggestion.
    A pair where both legs were typed by hand never qualifies.
    """
    if outflow.source == "manual" and inflow.source == "manual":
        return None
    if outflow.account_id == inflow.account_id:
        return None
    if _matches_last_payment(inflow, liabilities.get(inflow.account_id)):
        return "liability-attested"
    return None


def _has_transfer_signal(txn: Transaction, transfer_category_ids: set[int]) -> bool:
    """The transaction sits in a transfer category."""
    return txn.category_id in transfer_category_ids


#: Words that appear in half of all account names and so identify nothing.
_GENERIC_ACCOUNT_WORDS = frozenset({
    "bank", "card", "credit", "debit", "checking", "savings", "account",
    "loan", "mortgage", "joint", "personal", "business", "primary",
})


def _mentions_counterparty(outflow: Transaction, inflow_account: Account) -> bool:
    """Does the outflow's text name the account it paid into?

    "AMEX EPAYMENT" against an "American Express (9876)", or a description
    carrying the destination's last four. The mask is taken from the display
    name, which people commonly write as "Chase Checking (1234)".
    """
    haystack = " ".join(
        part for part in (outflow.description, outflow.merchant_name) if part
    ).lower()
    if not haystack:
        return False

    for raw in (inflow_account.display_name or "").lower().replace("(", " ").replace(")", " ").split():
        word = raw.strip("-_#.")
        if word.isdigit():
            # A last-four is distinctive; a single digit is not.
            if len(word) >= 3 and word in haystack:
                return True
        elif len(word) >= 4 and word not in _GENERIC_ACCOUNT_WORDS and word in haystack:
            return True
    return False


async def _transfer_category_ids(db: AsyncSession, user_id: int) -> set[int]:
    return set((await db.scalars(
        select(Category.id).where(
            Category.user_id == user_id, Category.treatment == "transfer"
        )
    )).all())


async def find_candidates(
    db: AsyncSession,
    user_id: int,
    *,
    transaction_ids: list[int] | None = None,
    window_days: int = WINDOW_DAYS,
) -> list[Candidate]:
    """Best one-to-one pairing for the given (or all unlinked) transactions."""
    accounts = {
        a.id: a for a in (await db.scalars(
            select(Account).where(Account.user_id == user_id)
        )).all()
    }
    if not accounts:
        return []
    account_ids = list(accounts)

    linked = set()
    for row in (await db.scalars(
        select(TransferLink).where(
            TransferLink.user_id == user_id, TransferLink.status != "rejected"
        )
    )).all():
        linked.add(row.outflow_txn_id)
        linked.add(row.inflow_txn_id)
    # A pair the user dismissed must never come back.
    rejected_pairs = {
        (row.outflow_txn_id, row.inflow_txn_id)
        for row in (await db.scalars(
            select(TransferLink).where(
                TransferLink.user_id == user_id, TransferLink.status == "rejected"
            )
        )).all()
    }

    scope = [
        Transaction.account_id.in_(account_ids),
        Transaction.pending.is_not(True),
    ]
    if transaction_ids:
        # Re-scan the counterparts of the touched rows too: the other leg may
        # have arrived in an earlier import.
        touched = (await db.scalars(
            select(Transaction).where(
                Transaction.id.in_(transaction_ids), *scope
            )
        )).all()
        if not touched:
            return []
        low = min(t.date_posted for t in touched) - timedelta(days=window_days)
        high = max(t.date_posted for t in touched) + timedelta(days=window_days)
        scope += [Transaction.date_posted >= low, Transaction.date_posted <= high]

    rows = (await db.scalars(select(Transaction).where(*scope))).all()
    outflows = [t for t in rows if t.amount < 0 and t.id not in linked]
    inflows = [t for t in rows if t.amount > 0 and t.id not in linked]
    if not outflows or not inflows:
        return []

    transfer_category_ids = await _transfer_category_ids(db, user_id)
    liabilities = {
        row.account_id: row for row in (await db.scalars(
            select(AccountLiability).where(
                AccountLiability.account_id.in_(account_ids)
            )
        )).all()
    }

    # Index inflows by exact magnitude — no tolerance, by design.
    by_amount: dict[str, list[Transaction]] = {}
    for txn in inflows:
        by_amount.setdefault(_amount_key(txn.amount), []).append(txn)

    scored: list[Candidate] = []
    for outflow in outflows:
        for inflow in by_amount.get(_amount_key(outflow.amount), []):
            if inflow.account_id == outflow.account_id:
                continue
            if abs((inflow.date_posted - outflow.date_posted).days) > window_days:
                continue
            if (outflow.id, inflow.id) in rejected_pairs:
                continue
            refusal = _refuses_outright(outflow, inflow, accounts)
            if refusal is not None:
                log.debug("transfers.refused", reason=refusal,
                          outflow=outflow.id, inflow=inflow.id)
                continue
            score, signals = _score(
                outflow, inflow, accounts, transfer_category_ids, liabilities
            )
            if score < SUGGEST_THRESHOLD:
                continue
            identified = _positively_identified(
                outflow, inflow, accounts, liabilities
            )
            scored.append(Candidate(
                outflow=outflow,
                inflow=inflow,
                score=score,
                kind=_kind_for(accounts[outflow.account_id], accounts[inflow.account_id]),
                signals=signals,
                identified=identified,
            ))

    return _resolve_one_to_one(scored)


def _resolve_one_to_one(scored: list[Candidate]) -> list[Candidate]:
    """Greedy best-first assignment, refusing to choose between near-ties."""
    by_outflow: dict[int, list[Candidate]] = {}
    for candidate in scored:
        by_outflow.setdefault(candidate.outflow.id, []).append(candidate)

    # An outflow whose top two candidates are indistinguishable cannot be
    # auto-confirmed either way; demote it so a human decides.
    ambiguous: set[int] = set()
    for outflow_id, options in by_outflow.items():
        if len(options) < 2:
            continue
        best, second = sorted(options, key=lambda c: -c.score)[:2]
        if best.score - second.score < AMBIGUITY_MARGIN:
            ambiguous.add(outflow_id)

    taken_out: set[int] = set()
    taken_in: set[int] = set()
    resolved: list[Candidate] = []
    for candidate in sorted(scored, key=lambda c: -c.score):
        if candidate.outflow.id in taken_out or candidate.inflow.id in taken_in:
            continue
        if candidate.outflow.id in ambiguous:
            # Two identical $500 payments on the same day. Whichever way this
            # is paired it is a coin toss, so the evidence is withdrawn and a
            # human decides — clearing `identified` is what actually holds it
            # back, since auto-confirmation reads that and not the score.
            candidate.identified = None
            candidate.signals = candidate.signals + ["ambiguous"]
        taken_out.add(candidate.outflow.id)
        taken_in.add(candidate.inflow.id)
        resolved.append(candidate)
    return resolved


async def promote_existing_suggestions(db: AsyncSession, user_id: int) -> int:
    """Re-judge already-suggested links against the current evidence rules.

    Necessary because a suggestion is *sticky*: :func:`find_candidates` skips
    any transaction already inside a non-rejected link, so a pair proposed
    under the old suggestions-only policy can never be reconsidered. Without
    this, changing the policy only affects transactions that arrive afterwards,
    and every pair matched before it stays in the review queue forever — which
    is exactly what a user saw as "100 possible transfers to review", all of
    them credit-card payments the bank had already identified.

    Re-scored from the transactions as they are now, not from the stored
    confidence: a category or a liability's last payment may have changed, and
    the stored score was computed under different rules. A link the user has
    already confirmed or rejected is never touched.
    """
    links = (await db.scalars(
        select(TransferLink).where(
            TransferLink.user_id == user_id,
            TransferLink.status == "suggested",
        )
    )).all()
    if not links:
        return 0

    accounts = {
        a.id: a for a in (await db.scalars(
            select(Account).where(Account.user_id == user_id)
        )).all()
    }
    liabilities = {
        row.account_id: row for row in (await db.scalars(
            select(AccountLiability).where(
                AccountLiability.account_id.in_(list(accounts) or [0])
            )
        )).all()
    }
    transfer_category_ids = await _transfer_category_ids(db, user_id)

    promoted = 0
    for link in links:
        outflow = await db.get(Transaction, link.outflow_txn_id)
        inflow = await db.get(Transaction, link.inflow_txn_id)
        if outflow is None or inflow is None:
            continue
        if outflow.account_id not in accounts or inflow.account_id not in accounts:
            continue

        identified = _positively_identified(outflow, inflow, accounts, liabilities)
        if identified is None:
            continue
        score, signals = _score(
            outflow, inflow, accounts, transfer_category_ids, liabilities
        )
        if not (AUTO_CONFIRM_ENABLED and score >= AUTO_CONFIRM_FLOOR):
            continue

        link.status = "confirmed"
        link.confidence = score
        link.matched_on = ("+".join(signals + [identified]))[:64]
        await db.flush()
        await apply_transfer_categories(db, link)
        promoted += 1

    if promoted:
        await db.commit()
        log.info("transfers.promoted_existing", user_id=user_id, confirmed=promoted)
    return promoted


def _changes_nothing(
    outflow: Transaction, inflow: Transaction, transfer_category_ids: set[int]
) -> bool:
    """Would linking this pair move any number the user sees?

    A confirmed link does exactly one thing to the arithmetic: it runs
    :func:`apply_transfer_categories`, which moves both legs into a
    transfer-treatment category so they stop counting as spending or income.
    When both legs are *already* in one, the link is metadata — true, possibly
    useful later, and worth nothing today.

    Asking a human to approve it is therefore pure busywork, and it is how a
    review queue reached 100 rows of credit-card payments that were already
    neutral on both sides. The categorizer already put the card payment in a
    transfer category; the pairing layer would only add a question about
    something already answered.

    An *uncategorized* leg is deliberately not treated as neutral — those are
    counted in the income and expense totals, so linking really would change
    them.
    """
    return (
        outflow.category_id in transfer_category_ids
        and inflow.category_id in transfer_category_ids
    )


async def discard_pointless_suggestions(db: AsyncSession, user_id: int) -> int:
    """Drop existing suggestions that should not be in the queue.

    Two kinds, and the distinction matters:

    * **it would change nothing.** Both legs are already net-worth-neutral, so
      confirming moves no money — see :func:`_changes_nothing`.
    * **it is not a movement.** The pair fails :func:`_refuses_outright`, so it
      was never a candidate under the current rules; it only exists because it
      was proposed under older ones.

    Deleted rather than tombstoned, matching ``DELETE /links/{id}``: a
    tombstone means "the user said no", which is not what happened. Deleting
    frees the matcher to reconsider the pair, and it will — arriving at the
    same answer and creating nothing, because :func:`match_transfers` and
    :func:`find_candidates` apply both tests before persisting one.
    """
    links = (await db.scalars(
        select(TransferLink).where(
            TransferLink.user_id == user_id,
            TransferLink.status == "suggested",
        )
    )).all()
    if not links:
        return 0

    accounts = {
        a.id: a for a in (await db.scalars(
            select(Account).where(Account.user_id == user_id)
        )).all()
    }
    transfer_category_ids = await _transfer_category_ids(db, user_id)
    discarded = 0
    for link in links:
        outflow = await db.get(Transaction, link.outflow_txn_id)
        inflow = await db.get(Transaction, link.inflow_txn_id)
        if outflow is None or inflow is None:
            continue
        pointless = _changes_nothing(outflow, inflow, transfer_category_ids)
        refused = _refuses_outright(outflow, inflow, accounts) is not None
        if not (pointless or refused):
            continue
        await db.delete(link)
        discarded += 1

    if discarded:
        await db.commit()
        log.info("transfers.discarded_pointless", user_id=user_id, count=discarded)
    return discarded


async def reconcile_suggestions(db: AsyncSession, user_id: int) -> dict:
    """Bring the existing review queue in line with the current rules.

    Split out of :func:`match_transfers` so it can run on the read path too.
    Finding *new* pairs is a scan over every unlinked transaction and belongs
    on a sync or a scheduled job; re-judging pairs already proposed touches
    only rows marked ``suggested``, which is the set the caller is about to
    display, so it is cheap enough to do whenever the queue is looked at.
    """
    promoted = await promote_existing_suggestions(db, user_id)
    discarded = await discard_pointless_suggestions(db, user_id)
    return {"promoted": promoted, "discarded": discarded}


async def match_transfers(
    db: AsyncSession,
    user_id: int,
    *,
    transaction_ids: list[int] | None = None,
) -> dict:
    """Find and persist transfer links. Returns counts by status."""
    # Self-healing, in two passes. Pairs proposed before the evidence rules
    # existed are re-judged rather than needing a one-off migration, and pairs
    # whose confirmation would change nothing are dropped rather than sitting
    # in a queue forever. Both run on the nightly rematch and on every
    # post-sync call, so a policy change reaches existing data on its own.
    reconciled = await reconcile_suggestions(db, user_id)
    promoted = reconciled["promoted"]
    discarded = reconciled["discarded"]

    candidates = await find_candidates(
        db, user_id, transaction_ids=transaction_ids
    )
    transfer_category_ids = await _transfer_category_ids(db, user_id)
    confirmed = suggested = 0
    auto_links: list[TransferLink] = []
    for candidate in candidates:
        auto_confirm = candidate.auto_confirms
        if not auto_confirm and _changes_nothing(
            candidate.outflow, candidate.inflow, transfer_category_ids
        ):
            # Nothing to gain and a question to answer: don't ask.
            discarded += 1
            continue
        link = TransferLink(
            user_id=user_id,
            outflow_txn_id=candidate.outflow.id,
            inflow_txn_id=candidate.inflow.id,
            amount=abs(candidate.outflow.amount),
            kind=candidate.kind,
            confidence=candidate.score,
            status="confirmed" if auto_confirm else "suggested",
            source="auto",
            matched_on=candidate.matched_on,
        )
        db.add(link)
        if auto_confirm:
            confirmed += 1
            auto_links.append(link)
        else:
            suggested += 1

    aligned = await align_confirmed_pairs(db, user_id)
    if aligned:
        await db.flush()

    if confirmed or suggested or aligned:
        await db.flush()
        # Confirming a link is only half the job: what actually stops the
        # double-count is both legs sitting in a transfer-treatment category,
        # which is what the manual confirm endpoint does next. Skipping it here
        # would leave an auto-confirmed pair still counted as spending — the
        # exact bug the pairing exists to prevent.
        for link in auto_links:
            await apply_transfer_categories(db, link)
        await db.commit()
        log.info(
            "transfers.matched",
            user_id=user_id, confirmed=confirmed, suggested=suggested,
        )
    return {
        "confirmed": confirmed,
        "suggested": suggested,
        "promoted": promoted,
        "discarded": discarded,
    }


async def apply_transfer_categories(db: AsyncSession, link: TransferLink) -> int:
    """Move both legs into a transfer-treatment category on confirmation.

    This is what actually stops the double-count when the two legs come from
    different files: the pairing is only meaningful once both sides are
    net-worth-neutral.

    A category the user chose by hand is never touched — that is the whole
    point of ``Transaction.category_source``.
    """
    from app.modules.accounts.categorizer import resolve_concept

    concept = {
        "credit_card_payment": "credit_card_payment",
        "loan_payment": "loan_payment",
        "investment_contribution": "investments_transfer",
    }.get(link.kind, "transfer")

    category_id = await resolve_concept(concept, link.user_id, db)
    if category_id is None:
        return 0

    transfer_ids = await _transfer_category_ids(db, link.user_id)
    # Paying a mortgage is spending: the leg leaving checking goes to
    # the Mortgage expense category, and only the mortgage account's own leg
    # stays a transfer, so the payment counts once, as an expense.
    mortgage_id = None
    if link.kind == "loan_payment":
        inflow = await db.get(Transaction, link.inflow_txn_id)
        inflow_account = inflow and await db.get(Account, inflow.account_id)
        if inflow_account is not None and inflow_account.account_type == "mortgage":
            mortgage_id = await resolve_concept("mortgage_payment", link.user_id, db)

    legs = [await db.get(Transaction, link.outflow_txn_id),
            await db.get(Transaction, link.inflow_txn_id)]

    # One movement, one category. Each leg used to keep whatever
    # transfer category it had been given on its own, so the checking side
    # of a move to savings read "Savings" and the savings side "Transfer".
    # A plain transfer keeps the more specific name if either leg was
    # already filed under a neutral category (the outflow's first, since it
    # names where the money went); the other kinds use their own concept.
    shared = category_id
    if concept == "transfer":
        for txn in legs:
            if txn is not None and txn.category_id in transfer_ids:
                shared = txn.category_id
                break

    changed = 0
    for txn in legs:
        if txn is None:
            continue
        if txn.category_source == "user":
            continue  # the user's own choice wins over any inference
        if txn.id == link.outflow_txn_id and mortgage_id is not None:
            if txn.category_id != mortgage_id:
                txn.category_id = mortgage_id
                txn.category_source = "auto"
                changed += 1
            continue
        if txn.category_id == shared:
            continue
        if txn.category_id in transfer_ids and mortgage_id is None and shared not in transfer_ids:
            continue  # already neutral, and nothing neutral to align it with
        txn.category_id = shared
        txn.category_source = "auto"
        changed += 1
    return changed


async def align_confirmed_pairs(db: AsyncSession, user_id: int) -> int:
    """Give the two legs of every confirmed pair the same category.

    Pairs confirmed before :func:`apply_transfer_categories` aligned them
    keep their split categories otherwise. Only pairs whose legs disagree
    and that the user has not categorised by hand are touched, so this is a
    no-op once the data is consistent.
    """
    from sqlalchemy.orm import aliased

    out_t, in_t = aliased(Transaction), aliased(Transaction)
    links = (await db.scalars(
        select(TransferLink)
        .join(out_t, out_t.id == TransferLink.outflow_txn_id)
        .join(in_t, in_t.id == TransferLink.inflow_txn_id)
        .where(
            TransferLink.user_id == user_id,
            TransferLink.status == "confirmed",
            TransferLink.kind != "loan_payment",
            out_t.category_id != in_t.category_id,
            or_(out_t.category_source.is_(None), out_t.category_source != "user"),
            or_(in_t.category_source.is_(None), in_t.category_source != "user"),
        )
    )).all()
    changed = 0
    for link in links:
        changed += await apply_transfer_categories(db, link)
    return changed

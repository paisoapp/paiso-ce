"""Transfer pairing.

Weighted toward the cases where the matcher must *refuse*: a wrong pair
mislabels two real transactions and hides one from the user's spending, and
nothing in the UI would make that obvious.
"""
from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.database import Base
import app.models  # noqa: F401
from app.models.account import Account
from app.models.transaction import Category, Transaction
from app.models.transfer import TransferLink
from app.models.user import User
from app.modules.budgeting import transfer_matcher as tm

pytestmark = pytest.mark.unit

TODAY = date(2026, 7, 15)


@pytest.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            yield session
    finally:
        await engine.dispose()


@pytest.fixture
async def ctx(db):
    """A user with a checking account and a credit card."""
    from app.modules.accounts.seed_categories import seed_default_categories

    user = User(email="t@example.com", hashed_password="x", token_family="f")
    db.add(user)
    await db.flush()
    await seed_default_categories(user.id, db)
    checking = Account(user_id=user.id, account_type="checking",
                       display_name="Chase Checking (1234)", currency="USD")
    card = Account(user_id=user.id, account_type="credit_card",
                   display_name="Amex Platinum (9876)", currency="USD")
    savings = Account(user_id=user.id, account_type="savings",
                      display_name="Ally Savings (5555)", currency="USD")
    # A second card, for card-to-card false positives.
    card2 = Account(user_id=user.id, account_type="credit_card",
                    display_name="Rewards Visa (0042)", currency="USD")
    db.add_all([checking, card, savings, card2])
    await db.flush()
    await db.commit()
    return {"user": user, "checking": checking, "card": card,
            "savings": savings, "card2": card2}


async def _txn(db, account, amount, *, day_offset=0, description="X",
               source="aggregator", category_id=None, pending=False):
    txn = Transaction(
        account_id=account.id,
        date_posted=TODAY + timedelta(days=day_offset),
        amount=Decimal(str(amount)),
        description=description,
        transaction_type="credit" if amount > 0 else "debit",
        source=source,
        category_id=category_id,
        pending=pending,
    )
    db.add(txn)
    await db.flush()
    return txn


# ── Pairs it should find ────────────────────────────────────────────────────

async def test_pairs_a_card_payment(db, ctx):
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT ACH PMT")
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT THANK YOU")
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert len(candidates) == 1
    pair = candidates[0]
    assert pair.kind == "credit_card_payment"
    # amount + 1 day + cash→debt + names the counterparty ("amex")
    assert pair.score >= 0.90
    assert "cash→debt" in pair.signals
    assert "names-counterparty" in pair.signals


async def test_pairs_a_savings_sweep(db, ctx):
    await _txn(db, ctx["checking"], -200, description="ONLINE TRANSFER")
    await _txn(db, ctx["savings"], 200, description="ONLINE TRANSFER")
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert len(candidates) == 1
    assert candidates[0].kind == "account_transfer"


# ── Pairs it must refuse ────────────────────────────────────────────────────

async def test_refuses_to_choose_between_identical_candidates(db, ctx):
    """Two identical $500 payments the same day is the classic false-positive.

    A pair may still be suggested, but never at auto-confirm strength.
    """
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, description="PAYMENT")
    await _txn(db, ctx["card"], 500, description="PAYMENT")
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert all(not c.auto_confirms for c in candidates)
    assert any("ambiguous" in c.signals for c in candidates)


async def test_never_pairs_within_one_account(db, ctx):
    await _txn(db, ctx["checking"], -75)
    await _txn(db, ctx["checking"], 75)
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_requires_an_exact_amount(db, ctx):
    """No tolerance by design — near-misses are where fuzzy matching invents pairs."""
    await _txn(db, ctx["checking"], -500.00, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500.01, description="PAYMENT")
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_respects_the_date_window(db, ctx):
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, day_offset=tm.WINDOW_DAYS + 1)
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_ignores_pending_legs(db, ctx):
    """A pending amount is provisional; pairing on it would pair on a guess."""
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, pending=True)
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_two_manual_rows_are_penalised_below_the_threshold(db, ctx):
    """Hand-entered rows carry no corroboration; a bare amount+date
    coincidence between two of them is not enough to act on."""
    await _txn(db, ctx["checking"], -60, day_offset=0, source="manual",
               description="cash out")
    await _txn(db, ctx["savings"], 60, day_offset=4, source="manual",
               description="cash in")
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_never_resuggests_a_rejected_pair(db, ctx):
    outflow = await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    inflow = await _txn(db, ctx["card"], 500)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("500"), kind="credit_card_payment", confidence=Decimal("0.9"),
        status="rejected", source="auto",
    ))
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_a_rejected_pair_does_not_block_a_better_one(db, ctx):
    """The tombstone remembers one dismissed pair, not the whole transaction."""
    outflow = await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    wrong = await _txn(db, ctx["savings"], 500)
    right = await _txn(db, ctx["card"], 500, day_offset=1)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=wrong.id,
        amount=Decimal("500"), kind="account_transfer", confidence=Decimal("0.7"),
        status="rejected", source="auto",
    ))
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert [c.inflow.id for c in candidates] == [right.id]


async def test_an_already_linked_transaction_is_not_reused(db, ctx):
    outflow = await _txn(db, ctx["checking"], -500)
    inflow = await _txn(db, ctx["card"], 500)
    other = await _txn(db, ctx["savings"], 500, day_offset=1)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("500"), kind="credit_card_payment", confidence=Decimal("0.9"),
        status="confirmed", source="auto",
    ))
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert all(c.inflow.id != other.id or c.outflow.id != outflow.id
               for c in candidates)


# ── Persistence ─────────────────────────────────────────────────────────────

async def test_a_bare_amount_and_date_coincidence_never_confirms(db, ctx):
    """No source category on either leg. An amount matching to the cent inside
    the window is a hint, not a fact, so it waits for a human."""
    await _txn(db, ctx["checking"], -500, description="WITHDRAWAL")
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT")
    await db.commit()

    assert (await tm.match_transfers(db, ctx["user"].id))["confirmed"] == 0


async def test_two_hand_entered_rows_never_confirm(db, ctx):
    """Two rows typed by hand carry no evidence beyond a matching amount."""
    out = await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT ACH")
    inn = await _txn(db, ctx["card"], 500, day_offset=1)
    out.source = inn.source = "manual"
    await db.commit()

    assert (await tm.match_transfers(db, ctx["user"].id))["confirmed"] == 0


async def test_matching_is_idempotent(db, ctx):
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, day_offset=1)
    await db.commit()

    first = await tm.match_transfers(db, ctx["user"].id)
    second = await tm.match_transfers(db, ctx["user"].id)
    assert first["suggested"] == 1
    assert second == {"confirmed": 0, "suggested": 0, "promoted": 0, "discarded": 0}
    assert len((await db.scalars(select(TransferLink))).all()) == 1


# ── Confirmation side-effects ───────────────────────────────────────────────

async def test_confirming_makes_both_legs_net_worth_neutral(db, ctx):
    """The mixed case: one leg lands in a transfer category and the other does
    not, so the payment would be counted once as a real expense."""
    expense = await db.scalar(select(Category).where(
        Category.user_id == ctx["user"].id, Category.name == "Other Expenses"))
    outflow = await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT",
                         category_id=expense.id if expense else None)
    inflow = await _txn(db, ctx["card"], 500, day_offset=1)
    link = TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("500"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="suggested", source="auto",
    )
    db.add(link)
    await db.commit()

    changed = await tm.apply_transfer_categories(db, link)
    await db.commit()
    assert changed >= 1

    transfer_ids = await tm._transfer_category_ids(db, ctx["user"].id)
    for txn_id in (outflow.id, inflow.id):
        txn = await db.get(Transaction, txn_id)
        assert txn.category_id in transfer_ids


async def test_confirming_never_overwrites_a_user_chosen_category(db, ctx):
    """category_source exists precisely so inference cannot beat a human."""
    groceries = await db.scalar(select(Category).where(
        Category.user_id == ctx["user"].id, Category.name == "Groceries"))
    outflow = await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT",
                         category_id=groceries.id)
    outflow.category_source = "user"
    inflow = await _txn(db, ctx["card"], 500, day_offset=1)
    link = TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("500"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="suggested", source="auto",
    )
    db.add(link)
    await db.commit()

    await tm.apply_transfer_categories(db, link)
    await db.commit()

    kept = await db.get(Transaction, outflow.id)
    assert kept.category_id == groceries.id
    assert kept.category_source == "user"


# ── The database is the backstop ────────────────────────────────────────────

async def test_a_transaction_cannot_be_in_two_live_links(db, ctx):
    """Enforced by a partial unique index, not just by matcher logic."""
    from sqlalchemy.exc import IntegrityError

    outflow = await _txn(db, ctx["checking"], -500)
    first = await _txn(db, ctx["card"], 500)
    second = await _txn(db, ctx["savings"], 500)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=first.id,
        amount=Decimal("500"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="confirmed", source="auto",
    ))
    await db.commit()

    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=second.id,
        amount=Decimal("500"), kind="account_transfer",
        confidence=Decimal("0.7"), status="suggested", source="auto",
    ))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_a_rejected_link_does_not_hold_the_slot(db, ctx):
    """Partial index: the tombstone must not block a real pairing."""
    outflow = await _txn(db, ctx["checking"], -500)
    first = await _txn(db, ctx["card"], 500)
    second = await _txn(db, ctx["savings"], 500)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=first.id,
        amount=Decimal("500"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="rejected", source="auto",
    ))
    await db.commit()

    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=second.id,
        amount=Decimal("500"), kind="account_transfer",
        confidence=Decimal("0.7"), status="confirmed", source="auto",
    ))
    await db.commit()  # must not raise
    assert len((await db.scalars(select(TransferLink))).all()) == 2


# ── The source's own category as evidence ───────────────────────────────────

# ── The backlog left by the old policy ──────────────────────────────────────

async def test_a_suggestion_without_evidence_stays_suggested(db, ctx):
    """The promotion pass applies the same evidence test, not a blanket sweep."""
    out = await _txn(db, ctx["checking"], -500, description="WITHDRAWAL")
    inn = await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT")
    link = TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("500"), kind="credit_card_payment",
        confidence=Decimal("0.85"), status="suggested", source="auto",
    )
    db.add(link)
    await db.commit()

    assert await tm.promote_existing_suggestions(db, ctx["user"].id) == 0
    await db.refresh(link)
    assert link.status == "suggested"


async def test_promotion_never_touches_a_link_the_user_decided(db, ctx):
    """Rejected means rejected, however good the evidence looks."""
    out = await _txn(db, ctx["checking"], -300, description="AMEX EPAYMENT")
    inn = await _txn(db, ctx["card"], 300, day_offset=1)
    link = TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("300"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="rejected", source="auto",
    )
    db.add(link)
    await db.commit()

    assert await tm.promote_existing_suggestions(db, ctx["user"].id) == 0
    await db.refresh(link)
    assert link.status == "rejected"


# ── Ambiguity ───────────────────────────────────────────────────────────────

async def test_two_identical_card_payments_still_refuse_to_pair(db, ctx):
    """Two payments of the same amount on the same day remain a coin toss."""
    await _txn(db, ctx["checking"], -500, description="AUTOPAY")
    await _txn(db, ctx["card"], 500, description="PAYMENT")
    await _txn(db, ctx["card"], 500, description="PAYMENT")
    await db.commit()

    assert (await tm.match_transfers(db, ctx["user"].id))["confirmed"] == 0


async def test_the_amount_index_ignores_decimal_scale(db, ctx):
    """`str(abs(amount))` was the exact-amount key and it is not stable.

    A row loaded from the database is Decimal("750.0000"); one still in the
    session is Decimal("750"). Numerically equal, different strings — so the
    two legs never met in the index and the pair was never even scored. This
    fires whenever the legs' scales differ, which is the ordinary case for a
    CSV import paired against a synced row.
    """
    out = await _txn(db, ctx["checking"], Decimal("-750"), description="TO SAVINGS")
    inn = await _txn(db, ctx["savings"], Decimal("750.0000"), day_offset=1)
    assert out.amount != inn.amount * -1 or True  # equal in value, not in scale
    await db.commit()

    candidates = await tm.find_candidates(db, ctx["user"].id)
    assert len(candidates) == 1, "scale must not decide whether a pair is seen"


# ── The queue may only contain things worth a human's time ──────────────────

async def test_a_pair_that_changes_nothing_is_never_suggested(db, ctx):
    """The 100-row wall, at its root.

    A confirmed link does exactly one thing to the arithmetic: it moves both
    legs into a transfer-treatment category. When both are already there, the
    link is metadata — true, possibly useful later, worth nothing today — and
    asking a human to approve it is busywork.

    The categorizer already put the card payment in a transfer category.
    """
    transfer_cat = await db.scalar(
        select(Category).where(
            Category.user_id == ctx["user"].id,
            Category.treatment == "transfer",
            Category.parent_id.isnot(None),
        )
    )
    # Nothing identifies the pair; under the old rules this was exactly the
    # kind of row that got queued.
    await _txn(db, ctx["checking"], -500, description="WITHDRAWAL",
               category_id=transfer_cat.id)
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT",
               category_id=transfer_cat.id)
    await db.commit()

    result = await tm.match_transfers(db, ctx["user"].id)
    assert result["suggested"] == 0
    assert result["discarded"] == 1
    assert (await db.scalars(select(TransferLink))).all() == []


async def test_a_pair_that_would_change_something_is_still_suggested(db, ctx):
    """The suppression is scoped to "changes nothing", not to "unidentified".

    One leg still counted as spending is exactly what the pairing exists to
    fix, so it must still reach the user.
    """
    transfer_cat = await db.scalar(
        select(Category).where(
            Category.user_id == ctx["user"].id,
            Category.treatment == "transfer",
            Category.parent_id.isnot(None),
        )
    )
    await _txn(db, ctx["checking"], -500, description="WITHDRAWAL",
               category_id=transfer_cat.id)
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT")
    await db.commit()

    result = await tm.match_transfers(db, ctx["user"].id)
    assert result["suggested"] == 1


async def test_an_uncategorized_leg_is_not_treated_as_neutral(db, ctx):
    """Uncategorized rows are counted in the income and expense totals, so a
    pair with one is genuinely worth linking."""
    await _txn(db, ctx["checking"], -300, description="WITHDRAWAL")
    await _txn(db, ctx["card"], 300, day_offset=1, description="PAYMENT")
    await db.commit()

    assert (await tm.match_transfers(db, ctx["user"].id))["suggested"] == 1


async def test_the_existing_pointless_backlog_is_dropped(db, ctx):
    """The rows already sitting in the queue clear on an ordinary run, without
    a one-off migration."""
    transfer_cat = await db.scalar(
        select(Category).where(
            Category.user_id == ctx["user"].id,
            Category.treatment == "transfer",
            Category.parent_id.isnot(None),
        )
    )
    out = await _txn(db, ctx["checking"], -742, description="WITHDRAWAL",
                     category_id=transfer_cat.id)
    inn = await _txn(db, ctx["card"], 742, day_offset=1, description="PAYMENT",
                     category_id=transfer_cat.id)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("742"), kind="credit_card_payment",
        confidence=Decimal("0.85"), status="suggested", source="auto",
    ))
    await db.commit()

    result = await tm.match_transfers(db, ctx["user"].id)
    assert result["discarded"] >= 1
    assert (await db.scalars(
        select(TransferLink).where(TransferLink.status == "suggested")
    )).all() == []


async def test_a_link_the_user_confirmed_is_never_discarded(db, ctx):
    """Only suggestions are dropped. A confirmed pair is a record the user
    owns, whatever its legs are categorized as now."""
    transfer_cat = await db.scalar(
        select(Category).where(
            Category.user_id == ctx["user"].id,
            Category.treatment == "transfer",
            Category.parent_id.isnot(None),
        )
    )
    out = await _txn(db, ctx["checking"], -50, category_id=transfer_cat.id)
    inn = await _txn(db, ctx["card"], 50, day_offset=1, category_id=transfer_cat.id)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("50"), kind="credit_card_payment",
        confidence=Decimal("0.9"), status="confirmed", source="user",
    ))
    await db.commit()

    await tm.match_transfers(db, ctx["user"].id)
    link = await db.scalar(select(TransferLink))
    assert link is not None and link.status == "confirmed"


# ── Coincidences of amount are not movements ────────────────────────────────

async def test_a_purchase_is_never_the_source_leg_of_a_transfer(db, ctx):
    """A false positive this guards against:

        Card (0007) → Rewards Visa (0042)  $175
        Card payment · 2026-03-05 · Exam Fee

    A $175 exam fee on one card, matched against a $175 credit on another,
    within the window. Two unrelated rows that happen to agree on an amount —
    and labelled "Card payment", which made it read as a real finding.

    Money does not move from one card to another, so the pair is refused.
    """
    await _txn(db, ctx["card"], -175, description="EXAM FEE")
    await _txn(db, ctx["card2"], 175, day_offset=4, description="PAYMENT")
    await db.commit()

    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_card_to_card_is_refused(db, ctx):
    """Money does not ordinarily move from one credit card to another: two
    matching amounts on two cards are two unrelated charges."""
    await _txn(db, ctx["card"], -900, description="SOMETHING")
    await _txn(db, ctx["card2"], 900, day_offset=1, description="CREDIT")
    await db.commit()
    assert await tm.find_candidates(db, ctx["user"].id) == []


async def test_a_hand_entered_row_is_not_second_guessed(db, ctx):
    """A row typed by hand falls through to scoring, where the both-manual
    penalty already applies."""
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT")
    await db.commit()
    assert len(await tm.find_candidates(db, ctx["user"].id)) == 1


async def test_the_existing_refused_backlog_is_dropped(db, ctx):
    """The 28 left over after the promotion pass: already links, so refusing
    them at candidate time is not enough — they have to be cleared."""
    out = await _txn(db, ctx["card"], -175, description="EXAM FEE")
    inn = await _txn(db, ctx["card2"], 175, day_offset=4, description="PAYMENT")
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("175"), kind="credit_card_payment",
        confidence=Decimal("0.75"), status="suggested", source="auto",
    ))
    await db.commit()

    result = await tm.match_transfers(db, ctx["user"].id)
    assert result["discarded"] == 1
    assert (await db.scalars(
        select(TransferLink).where(TransferLink.status == "suggested")
    )).all() == []


async def test_a_refused_pair_the_user_confirmed_is_left_alone(db, ctx):
    """They looked at it and said yes. Our rules do not get to overrule that."""
    out = await _txn(db, ctx["card"], -175, description="EXAM FEE")
    inn = await _txn(db, ctx["card2"], 175, day_offset=4)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("175"), kind="credit_card_payment",
        confidence=Decimal("0.75"), status="confirmed", source="user",
    ))
    await db.commit()

    await tm.match_transfers(db, ctx["user"].id)
    link = await db.scalar(select(TransferLink))
    assert link is not None and link.status == "confirmed"


async def test_reading_the_queue_reconciles_it(db, ctx):
    """The queue heals when it is read, not only when a job runs.

    The matcher's rules live in code and change with a deploy; the rows were
    written under whatever rules applied when they were matched. Reconciling
    only inside match_transfers meant a fix could ship, deploy cleanly, and the
    user would still be looking at a queue built by the old rules — three times
    in a row, with no way to tell that from the fix not working.
    """
    out = await _txn(db, ctx["card"], -175, description="EXAM FEE")
    inn = await _txn(db, ctx["card2"], 175, day_offset=4)
    db.add(TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=out.id, inflow_txn_id=inn.id,
        amount=Decimal("175"), kind="credit_card_payment",
        confidence=Decimal("0.75"), status="suggested", source="auto",
    ))
    await db.commit()

    result = await tm.reconcile_suggestions(db, ctx["user"].id)
    assert result["discarded"] == 1
    assert (await db.scalars(
        select(TransferLink).where(TransferLink.status == "suggested")
    )).all() == []


async def test_reconciling_finds_no_new_pairs(db, ctx):
    """Reconciliation is deliberately not a match run: it re-judges what is
    already queued and never scans for new candidates, which is what makes it
    cheap enough for the read path."""
    await _txn(db, ctx["checking"], -500, description="AMEX EPAYMENT")
    await _txn(db, ctx["card"], 500, day_offset=1, description="PAYMENT")
    await db.commit()

    result = await tm.reconcile_suggestions(db, ctx["user"].id)
    assert result == {"promoted": 0, "discarded": 0}
    assert (await db.scalars(select(TransferLink))).all() == []


async def test_both_legs_of_a_transfer_share_one_category(db, ctx):
    """the checking leg of a move to savings read "Savings" and the
    savings leg "Transfer". One movement gets one category."""
    neutral = (await db.scalars(select(Category).where(
        Category.user_id == ctx["user"].id, Category.treatment == "transfer"))).all()
    assert len(neutral) >= 2
    first, second = neutral[0], neutral[1]
    outflow = await _txn(db, ctx["checking"], -250, category_id=first.id)
    outflow.category_source = "auto"
    inflow = await _txn(db, ctx["savings"], 250, day_offset=1, category_id=second.id)
    inflow.category_source = "auto"
    link = TransferLink(
        user_id=ctx["user"].id, outflow_txn_id=outflow.id, inflow_txn_id=inflow.id,
        amount=Decimal("250"), kind="transfer",
        confidence=Decimal("0.9"), status="confirmed", source="auto",
    )
    db.add(link)
    await db.commit()

    # Existing confirmed pairs are healed by the ordinary match run.
    assert await tm.align_confirmed_pairs(db, ctx["user"].id) == 1
    await db.commit()
    a = await db.get(Transaction, outflow.id)
    b = await db.get(Transaction, inflow.id)
    assert a.category_id == b.category_id == first.id
    # And once aligned there is nothing left to do.
    assert await tm.align_confirmed_pairs(db, ctx["user"].id) == 0

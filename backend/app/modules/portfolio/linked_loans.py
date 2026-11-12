"""Keep a property's loan in step with the mortgage account behind it.

A property's debt is counted once, through ``Asset.loan``; the account linked
to it (``Account.linked_asset_id``) is left out of liabilities so the two are
never added together (see ``valuation.is_asset_backed_loan_account``). When
that account is synced from a bank, or its balance is typed by hand, its
balance is the truth about what is owed, so the loan follows it: the balance
becomes the loan's anchor and the schedule is projected forward from there.
"""
from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.account import Account
from app.models.asset import Loan, PaymentSchedule


async def rebuild_schedule(db: AsyncSession, loan: Loan) -> None:
    """Replace the loan's payment schedule with one built from its terms now."""
    from app.api.assets import LoanIn, _amortize

    await db.execute(delete(PaymentSchedule).where(PaymentSchedule.loan_id == loan.id))
    loan_in = LoanIn(
        principal=float(loan.principal),
        rate_apr=float(loan.rate_apr),
        term_months=loan.term_months,
        origination=loan.origination,
        extra_principal_monthly=float(loan.extra_principal_monthly or 0),
        insurance_monthly=float(loan.insurance_monthly or 0),
        property_tax_monthly=float(loan.property_tax_monthly or 0),
        escrow_monthly=float(loan.escrow_monthly or 0),
    )
    for row in _amortize(
        loan_in,
        balance_override=float(loan.balance_override) if loan.balance_override is not None else None,
        balance_override_date=loan.balance_override_date,
    ):
        db.add(PaymentSchedule(loan_id=loan.id, **row))


async def fill_from_payments(db: AsyncSession, account: Account, loan: Loan) -> bool:
    """Escrow and extra principal from the payments the lender posted,
    unless the user typed their own. Returns True when either changed."""
    from app.modules.portfolio.mortgage_payments import account_payment_parts, infer_from_payments

    parts = await account_payment_parts(db, account)
    if not parts:
        return False
    found = infer_from_payments(parts)
    changed = False
    if (
        found.escrow_monthly is not None and loan.escrow_source != "user"
        and not float(loan.insurance_monthly or 0) and not float(loan.property_tax_monthly or 0)
        and round(float(loan.escrow_monthly or 0), 2) != found.escrow_monthly
    ):
        loan.escrow_monthly = found.escrow_monthly
        loan.escrow_source = "payments"
        changed = True
    if (
        found.extra_principal_monthly is not None and loan.extra_principal_source != "user"
        and round(float(loan.extra_principal_monthly or 0), 2) != found.extra_principal_monthly
    ):
        loan.extra_principal_monthly = found.extra_principal_monthly
        loan.extra_principal_source = "payments"
        changed = True
    return changed


async def sync_linked_loan(db: AsyncSession, account: Account) -> bool:
    """Anchor the linked property's loan on this account's balance.

    Returns True when the loan changed. Does nothing for an account with no
    property, no balance, or a balance the loan already carries, so it is
    cheap to call on every balance update.
    """
    if account.linked_asset_id is None or account.current_balance is None:
        return False
    loan = await db.scalar(select(Loan).where(Loan.asset_id == account.linked_asset_id))
    if loan is None:
        return False
    owed = round(abs(float(account.current_balance)), 2)
    today = date.today()
    filled = await fill_from_payments(db, account, loan)
    if (
        loan.balance_override is not None
        and round(float(loan.balance_override), 2) == owed
        and loan.balance_override_date == today
    ):
        if filled:
            await db.flush()
            await rebuild_schedule(db, loan)
        return filled
    loan.balance_override = owed
    loan.balance_override_date = today
    await db.flush()
    await rebuild_schedule(db, loan)
    return True


async def release_linked_property(
    db: AsyncSession, account: Account, *, delete_property: bool
) -> None:
    """Let go of the property behind an account that is about to be deleted.

    The property's debt is counted through its loan, not through the account,
    so deleting only the account left the loan behind and still counted:
    phantom debt with no account to explain it and, on the property page, no
    way to remove it. Whatever happens to the property, its loan goes with the
    account that held it.

    ``delete_property`` removes the property as well. Otherwise it stays, owned
    outright, with its value and history.
    """
    from app.models.asset import Asset

    asset_id = account.linked_asset_id
    if asset_id is None:
        return
    account.linked_asset_id = None
    await db.flush()

    loan = await db.scalar(select(Loan).where(Loan.asset_id == asset_id))
    if loan is not None:
        await db.execute(delete(PaymentSchedule).where(PaymentSchedule.loan_id == loan.id))
        await db.execute(delete(Loan).where(Loan.id == loan.id))
    if delete_property:
        from sqlalchemy import update

        # Any other account still pointing at it lets go first.
        await db.execute(
            update(Account).where(Account.linked_asset_id == asset_id).values(linked_asset_id=None)
        )
        await db.execute(delete(Asset).where(Asset.id == asset_id))
    # The ORM's copy of the asset still thinks it has a loan.
    asset = await db.get(Asset, asset_id) if not delete_property else None
    if asset is not None:
        await db.refresh(asset, ["loan"])

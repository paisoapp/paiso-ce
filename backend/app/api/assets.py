"""Assets (property, vehicles, metals) and associated loans."""
import base64
import calendar
import html
import json
import re
import uuid
from datetime import date
from typing import Optional
from urllib.parse import urlparse, urlsplit

import httpx
import structlog
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete as sql_delete, select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.validation import (
    NonNegativeMoney, PastDate, Percent, PositiveMoney, ReasonableDate, TermMonths,
)
from app.core.ratelimit import check_rate
from app.core.storage import get_storage
from app.core.uploads import (
    ASSET_PHOTO_MAX_BYTES,
    UPLOAD_RATE,
    check_storage_quota,
    read_capped,
    sniff_image,
)
from app.models.account import Account
from app.models.asset import ASSET_CATEGORIES, Asset, Loan, PaymentSchedule
from app.models.user import User
from app.modules.portfolio.valuation import current_loan_balance

# A custom-thumbnail value becomes a storage key (``thumbnails/<name>``), so it
# must be a bare filename and nothing else. The client controls metadata_json,
# and before this guard a value like ``../logos/acct_123.png`` walked out of the
# thumbnails/ prefix into any other user's files under the storage root.
# Names are only ever generated server-side by the upload endpoint as
# ``{user_id}_{asset_id}_{hex}.{ext}``, so this pattern is all that is valid.
_THUMB_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$")


def _safe_thumb_name(name) -> str | None:
    """Return `name` only if it is a bare, safe thumbnail filename, else None.

    Rejects anything with a path separator or a parent-directory hop, so a
    client-supplied value can never escape the thumbnails/ prefix."""
    if not isinstance(name, str) or ".." in name or "/" in name or "\\" in name:
        return None
    return name if _THUMB_NAME_RE.match(name) else None


def _thumb_key(filename: str) -> str:
    safe = _safe_thumb_name(filename)
    if safe is None:
        # Caller passed something that is not a server-generated name. Never
        # build a key from it — that is the traversal.
        raise HTTPException(status_code=400, detail="Invalid thumbnail reference")
    return f"thumbnails/{safe}"


def _owned_thumb(asset: "Asset", name) -> str | None:
    """`name` only when it is a safe file name that this asset's upload made.

    Uploads are named ``<user_id>_<asset_id>_<hex>.<ext>``. A safe name was not
    enough: one asset could name another user's file and then read it through
    its own thumbnail route, or delete it by removing its own photo.
    """
    safe = _safe_thumb_name(name)
    if safe and safe.startswith(f"{asset.user_id}_{asset.id}_"):
        return safe
    return None


def _sanitize_meta(meta: dict | None, keep: str | None = None) -> dict | None:
    """Metadata from a client, with the server-owned keys made safe.

    ``custom_thumbnail`` is set only by the upload endpoint. A client may keep
    the photo the asset already has (``keep``, the stored name) or drop it, but
    never point the asset at another file. The photo's size is the
    server's to record (the storage quota adds it up); a client value is
    never kept."""
    if not isinstance(meta, dict):
        return meta
    meta = {k: v for k, v in meta.items() if k != "custom_thumbnail_bytes"}
    ct = meta.get("custom_thumbnail")
    if ct is not None and (keep is None or ct != keep):
        meta = {k: v for k, v in meta.items() if k != "custom_thumbnail"}
    return meta


log = structlog.get_logger()


def _parse_meta(asset: "Asset") -> dict:
    """Return the asset's metadata_json as a dict, or {} on missing/invalid."""
    try:
        return json.loads(asset.metadata_json) if asset.metadata_json else {}
    except Exception:
        return {}
router = APIRouter(prefix="/api/assets", tags=["assets"])

# Only these hosts may be fetched for thumbnails — prevents SSRF.
_ALLOWED_THUMBNAIL_HOSTS = frozenset([
    "zillow.com", "www.zillow.com",
    "en.wikipedia.org",
])


def _assert_allowed_host(url: str) -> None:
    """HTTPS to an allowed host, or 400. Checked on the URL the user saved and
    again on every redirect, so a redirect cannot carry the request to a host
    the list does not name (an address on the server's own network)."""
    try:
        parts = urlparse(url)
        host = (parts.hostname or "").lower()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid URL")
    if parts.scheme != "https" or host not in _ALLOWED_THUMBNAIL_HOSTS:
        raise HTTPException(status_code=400, detail="URL host not permitted")


async def _check_redirect(request: httpx.Request) -> None:
    _assert_allowed_host(str(request.url))


# ── Schemas ───────────────────────────────────────────────────────────────────

class LoanIn(BaseModel):
    principal: PositiveMoney
    rate_apr: Percent
    term_months: TermMonths
    origination: ReasonableDate
    extra_principal_monthly: NonNegativeMoney = 0
    insurance_monthly: NonNegativeMoney = 0
    property_tax_monthly: NonNegativeMoney = 0
    #: Escrow read from the payments, used when insurance and property
    #: tax are both empty. Not something the form sends.
    escrow_monthly: NonNegativeMoney = 0


class AssetCreate(BaseModel):
    category: str
    name: str = Field(min_length=1, max_length=100)
    ownership_pct: float = Field(100.0, gt=0, le=100)
    current_value: Optional[PositiveMoney] = None
    acquired_value: Optional[PositiveMoney] = None
    acquired_at: Optional[PastDate] = None
    metadata_json: Optional[dict] = None
    loan: Optional[LoanIn] = None


class LoanUpdate(BaseModel):
    """Partial loan update — only provided fields are changed."""
    # The loan's terms, as the user corrects them. Any change rebuilds the
    # amortization schedule.
    principal: Optional[PositiveMoney] = None
    rate_apr: Optional[Percent] = None
    term_months: Optional[TermMonths] = None
    origination: Optional[ReasonableDate] = None
    extra_principal_monthly: Optional[NonNegativeMoney] = None
    insurance_monthly: Optional[NonNegativeMoney] = None
    property_tax_monthly: Optional[NonNegativeMoney] = None
    # Provide the known-good actual balance to anchor the projection forward.
    balance_override: Optional[NonNegativeMoney] = None
    balance_override_date: Optional[PastDate] = None
    # Set True to clear the override and revert to schedule-derived balance.
    clear_override: bool = False


class AssetUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    category: Optional[str] = None
    current_value: Optional[PositiveMoney] = None
    acquired_value: Optional[PositiveMoney] = None
    acquired_at: Optional[PastDate] = None
    ownership_pct: Optional[float] = Field(None, gt=0, le=100)
    metadata_json: Optional[dict] = None
    loan: Optional[LoanUpdate] = None


# ── Amortization ──────────────────────────────────────────────────────────────

def _amortize(
    loan_in: LoanIn,
    balance_override: float | None = None,
    balance_override_date: date | None = None,
) -> list[dict]:
    """Build an amortization schedule.

    When *balance_override* and *balance_override_date* are supplied the
    schedule is anchored to that known balance and projected forward from that
    date, using the remaining term based on the original origination date.
    The months before the anchor keep their rows, on the original terms:
   without them a loan re-anchored at every sync had no past, and
    the Mortgage tab could not split this year's payments.
    """
    if balance_override is not None and balance_override_date is not None:
        past = [
            row for row in _amortize(loan_in)
            if (row["payment_date"].year, row["payment_date"].month)
            < (balance_override_date.year, balance_override_date.month)
        ]
        ahead = _amortize_from(loan_in, balance_override, balance_override_date)
        for i, row in enumerate(ahead, start=len(past) + 1):
            row["month_number"] = i
        return past + ahead
    return _amortize_from(loan_in, None, None)


def _amortize_from(
    loan_in: LoanIn,
    balance_override: float | None,
    balance_override_date: date | None,
) -> list[dict]:
    """``_amortize`` from one starting point: the anchor when given, else the
    loan's origination."""
    monthly_rate = loan_in.rate_apr / 100 / 12
    escrow = (loan_in.insurance_monthly + loan_in.property_tax_monthly) or loan_in.escrow_monthly

    if balance_override is not None and balance_override_date is not None:
        orig = loan_in.origination
        elapsed = (balance_override_date.year - orig.year) * 12 + (balance_override_date.month - orig.month)
        remaining = max(1, loan_in.term_months - elapsed)
        start = balance_override_date
        p = balance_override
    else:
        remaining = loan_in.term_months
        start = loan_in.origination
        p = loan_in.principal

    if monthly_rate == 0:
        base_payment = p / remaining
    else:
        base_payment = p * monthly_rate * (1 + monthly_rate) ** remaining / ((1 + monthly_rate) ** remaining - 1)

    schedule = []
    balance = p

    for i in range(1, remaining + 1):
        interest = balance * monthly_rate
        principal_pmt = base_payment - interest + loan_in.extra_principal_monthly
        principal_pmt = min(principal_pmt, balance)
        balance = max(0.0, balance - principal_pmt)
        mo = (start.month - 1 + i) % 12 + 1
        yr = start.year + (start.month - 1 + i) // 12
        # Clamp the billing day to the last valid day of the target month so a
        # start date on the 29th–31st doesn't raise ValueError in short months
        # (e.g. a Jan-31 origination would otherwise produce an invalid Feb 31).
        day = min(start.day, calendar.monthrange(yr, mo)[1])
        pmt_date = date(yr, mo, day)
        schedule.append({
            "month_number": i,
            "payment_date": pmt_date,
            "principal": round(principal_pmt, 4),
            "interest": round(interest, 4),
            "escrow": round(escrow, 4),
            "balance": round(balance, 4),
        })
        if balance <= 0:
            break

    return schedule


# ── Output helpers ────────────────────────────────────────────────────────────

def _loan_out(loan: Loan, schedule_rows: list) -> dict:
    today = date.today()
    schedule = [
        {
            "month_number": ps.month_number,
            "payment_date": ps.payment_date.isoformat() if hasattr(ps.payment_date, "isoformat") else str(ps.payment_date),
            "principal": float(ps.principal),
            "interest": float(ps.interest),
            "escrow": float(ps.escrow),
            "balance": float(ps.balance),
        }
        for ps in schedule_rows
    ]
    remaining = [s for s in schedule if s["payment_date"] >= today.isoformat()]

    # Same rule as the portfolio summary and breakdown, so the property page,
    # the Portfolio tables and net worth all report one balance.
    current_balance = current_loan_balance(loan, today, schedule=schedule_rows)

    monthly_payment = (
        remaining[0]["principal"] + remaining[0]["interest"] + remaining[0]["escrow"]
        if remaining
        else 0.0
    )
    return {
        "id": loan.id,
        "principal": float(loan.principal),
        "rate_apr": float(loan.rate_apr),
        "term_months": loan.term_months,
        "origination": loan.origination.isoformat(),
        "extra_principal_monthly": float(loan.extra_principal_monthly),
        "insurance_monthly": float(loan.insurance_monthly),
        "property_tax_monthly": float(loan.property_tax_monthly),
        # Read from the payments: shown with where it came from.
        "escrow_monthly": float(loan.escrow_monthly) if loan.escrow_monthly is not None else None,
        "escrow_source": loan.escrow_source,
        "extra_principal_source": loan.extra_principal_source,
        "balance_override": float(loan.balance_override) if loan.balance_override is not None else None,
        "balance_override_date": loan.balance_override_date.isoformat() if loan.balance_override_date else None,
        "current_balance": current_balance,
        "monthly_payment": monthly_payment,
        "schedule": schedule,
    }


def _asset_out(asset: Asset, schedule_rows: list | None = None) -> dict:
    return {
        "id": asset.id,
        "category": asset.category,
        "name": asset.name,
        "ownership_pct": float(asset.ownership_pct),
        "current_value": float(asset.current_value) if asset.current_value else None,
        "acquired_value": float(asset.acquired_value) if asset.acquired_value else None,
        "acquired_at": asset.acquired_at.isoformat() if asset.acquired_at else None,
        "metadata_json": json.loads(asset.metadata_json) if asset.metadata_json else None,
        "loan": _loan_out(asset.loan, schedule_rows or []) if asset.loan else None,
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("")
async def list_assets(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    assets = (await db.scalars(
        select(Asset).where(Asset.user_id == user.id).order_by(Asset.category, Asset.name)
    )).all()

    # Load payment schedules for all loans in one query
    loan_ids = [a.loan.id for a in assets if a.loan]
    schedules: dict[int, list] = {lid: [] for lid in loan_ids}
    if loan_ids:
        rows = (await db.scalars(
            select(PaymentSchedule)
            .where(PaymentSchedule.loan_id.in_(loan_ids))
            .order_by(PaymentSchedule.loan_id, PaymentSchedule.month_number)
        )).all()
        for ps in rows:
            schedules[ps.loan_id].append(ps)

    return [_asset_out(a, schedules.get(a.loan.id) if a.loan else None) for a in assets]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_asset(
    body: AssetCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if body.category not in ASSET_CATEGORIES:
        raise HTTPException(status_code=400, detail=f"Invalid category. Must be one of: {ASSET_CATEGORIES}")

    asset = Asset(
        user_id=user.id,
        category=body.category,
        name=body.name,
        ownership_pct=body.ownership_pct,
        current_value=body.current_value,
        acquired_value=body.acquired_value,
        acquired_at=body.acquired_at,
        metadata_json=json.dumps(_sanitize_meta(body.metadata_json)) if body.metadata_json else None,
    )
    db.add(asset)
    await db.flush()

    if body.loan:
        loan = Loan(
            asset_id=asset.id,
            principal=body.loan.principal,
            rate_apr=body.loan.rate_apr,
            term_months=body.loan.term_months,
            origination=body.loan.origination,
            extra_principal_monthly=body.loan.extra_principal_monthly,
            insurance_monthly=body.loan.insurance_monthly,
            property_tax_monthly=body.loan.property_tax_monthly,
        )
        db.add(loan)
        await db.flush()

        for row in _amortize(body.loan):
            db.add(PaymentSchedule(loan_id=loan.id, **row))

    await db.commit()
    await db.refresh(asset)

    schedule_rows = []
    if body.loan:
        # Reload loan id after commit
        loan_obj = await db.scalar(select(Loan).where(Loan.asset_id == asset.id))
        if loan_obj:
            schedule_rows = (await db.scalars(
                select(PaymentSchedule)
                .where(PaymentSchedule.loan_id == loan_obj.id)
                .order_by(PaymentSchedule.month_number)
            )).all()
            asset.loan = loan_obj

    return _asset_out(asset, schedule_rows)


@router.patch("/{asset_id}")
async def update_asset(
    asset_id: int,
    body: AssetUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    from sqlalchemy.orm import selectinload as _sli
    asset = await db.scalar(
        select(Asset)
        .where(Asset.id == asset_id, Asset.user_id == user.id)
        .options(_sli(Asset.loan))
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    if body.name is not None:
        asset.name = body.name
    if body.category is not None:
        asset.category = body.category
    if body.current_value is not None:
        asset.current_value = body.current_value
    if body.acquired_value is not None:
        asset.acquired_value = body.acquired_value
    if body.acquired_at is not None:
        asset.acquired_at = body.acquired_at
    if body.ownership_pct is not None:
        asset.ownership_pct = body.ownership_pct
    if body.metadata_json is not None:
        before = _parse_meta(asset)
        meta = _sanitize_meta(body.metadata_json, keep=before.get("custom_thumbnail"))
        # Keep the recorded photo size while the photo itself is unchanged.
        if (
            "custom_thumbnail_bytes" in before
            and meta.get("custom_thumbnail") == before.get("custom_thumbnail")
        ):
            meta["custom_thumbnail_bytes"] = before["custom_thumbnail_bytes"]
        asset.metadata_json = json.dumps(meta)

    loan_id: int | None = None
    regenerate_schedule = False
    if body.loan is not None and asset.loan:
        lu = body.loan
        loan = asset.loan
        loan_id = loan.id

        for field in ("principal", "rate_apr", "term_months", "origination"):
            value = getattr(lu, field)
            if value is not None and value != getattr(loan, field):
                setattr(loan, field, value)
                regenerate_schedule = True
        # The form sends every figure; one that differs from what is stored
        # is the user's own, and a sync never replaces it.
        if lu.extra_principal_monthly is not None:
            if round(float(lu.extra_principal_monthly), 2) != round(float(loan.extra_principal_monthly or 0), 2):
                loan.extra_principal_source = "user"
            loan.extra_principal_monthly = lu.extra_principal_monthly
            regenerate_schedule = True
        if lu.insurance_monthly is not None:
            loan.insurance_monthly = lu.insurance_monthly
            regenerate_schedule = True
        if lu.property_tax_monthly is not None:
            loan.property_tax_monthly = lu.property_tax_monthly
            regenerate_schedule = True
        if float(loan.insurance_monthly or 0) or float(loan.property_tax_monthly or 0):
            loan.escrow_source = "user"
        if lu.clear_override:
            loan.balance_override = None
            loan.balance_override_date = None
            regenerate_schedule = True
        elif lu.balance_override is not None:
            loan.balance_override = lu.balance_override
            loan.balance_override_date = lu.balance_override_date or date.today()
            regenerate_schedule = True

        if regenerate_schedule:
            # Rebuild the amortization schedule within the same transaction so
            # we never commit with the loan updated but the schedule stale.
            await db.execute(
                sql_delete(PaymentSchedule).where(PaymentSchedule.loan_id == loan_id)
            )
            loan_in = LoanIn(
                principal=float(loan.principal),
                rate_apr=float(loan.rate_apr),
                term_months=loan.term_months,
                origination=loan.origination,
                extra_principal_monthly=float(loan.extra_principal_monthly),
                insurance_monthly=float(loan.insurance_monthly),
                property_tax_monthly=float(loan.property_tax_monthly),
                escrow_monthly=float(loan.escrow_monthly or 0),
            )
            for row in _amortize(
                loan_in,
                balance_override=float(loan.balance_override) if loan.balance_override is not None else None,
                balance_override_date=loan.balance_override_date,
            ):
                db.add(PaymentSchedule(loan_id=loan_id, **row))

    await db.commit()

    # Reload asset after commit (commit expires all ORM objects).
    asset = await db.scalar(
        select(Asset)
        .where(Asset.id == asset_id)
        .options(_sli(Asset.loan))
    )

    schedule_rows = []
    if loan_id:
        schedule_rows = (await db.scalars(
            select(PaymentSchedule)
            .where(PaymentSchedule.loan_id == loan_id)
            .order_by(PaymentSchedule.month_number)
        )).all()
    elif asset and asset.loan:
        schedule_rows = (await db.scalars(
            select(PaymentSchedule)
            .where(PaymentSchedule.loan_id == asset.loan.id)
            .order_by(PaymentSchedule.month_number)
        )).all()

    return _asset_out(asset, schedule_rows)


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(
    asset_id: int,
    delete_accounts: bool = False,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Delete a property or other asset, and its loan.

    A mortgage account linked to it is kept and unlinked, so it is counted on
    its own balance from then on. ``delete_accounts`` deletes the linked
    accounts as well, typically the mortgage account Add Property made, which
    has nothing else in it.
    """
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user.id)
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    if delete_accounts:
        from app.api.accounts import delete_account_and_children
        for acct in (await db.scalars(
            select(Account).where(
                Account.user_id == user.id,
                Account.linked_asset_id == asset_id,
            )
        )).all():
            await delete_account_and_children(db, acct, delete_property=True)
        await db.flush()

    # Explicit ordered deletes to satisfy FK constraints (PRAGMA foreign_keys=ON).
    # 1. Unlink any mortgage accounts that reference this asset.
    await db.execute(
        sql_update(Account)
        .where(Account.linked_asset_id == asset_id)
        .values(linked_asset_id=None)
    )
    # 2. Find the loan (if any), delete its payment schedule, then the loan itself.
    loan = await db.scalar(select(Loan).where(Loan.asset_id == asset_id))
    if loan:
        await db.execute(sql_delete(PaymentSchedule).where(PaymentSchedule.loan_id == loan.id))
        await db.execute(sql_delete(Loan).where(Loan.id == loan.id))
    # 3. Delete the asset.
    await db.execute(sql_delete(Asset).where(Asset.id == asset_id))
    await db.commit()


def _https_image_url(url: str | None) -> str | None:
    """An auto-fetched thumbnail URL as the browser may load it: https with
    a host, or None. The URL comes from a page the app does not
    control (Zillow's og:image, Wikipedia's summary), so a javascript:,
    data: or plain http: value is dropped rather than handed to an <img>."""
    if not url:
        return None
    url = html.unescape(url).strip()
    if len(url) > 2048:
        return None
    parts = urlsplit(url)
    if parts.scheme.lower() != "https" or not parts.hostname:
        return None
    return url


@router.get("/{asset_id}/thumbnail")
async def get_asset_thumbnail(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Return a thumbnail image URL for an asset.
    - Property: extracts og:image from the stored Zillow URL
    - Vehicle: uses Wikipedia REST API to find a car photo
    """
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user.id)
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    meta = _parse_meta(asset)

    # Custom uploaded thumbnail takes priority over auto-fetched ones. Only a
    # safe, server-generated name is honoured — anything else (a traversal
    # attempt, or legacy bad data) is ignored and we fall through to the
    # auto-fetched image.
    custom = _owned_thumb(asset, meta.get("custom_thumbnail"))
    if custom:
        raw = await get_storage().get(_thumb_key(custom))
        if raw is not None:
            ext = custom.rsplit(".", 1)[-1].lower()
            mime = f"image/{ext}" if ext in ("jpg", "jpeg", "png", "webp", "gif") else "image/jpeg"
            if ext == "jpg":
                mime = "image/jpeg"
            data_url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
            return {"url": data_url}

    url: str | None = None

    if asset.category in ("primary_home", "rental"):
        zillow_url = meta.get("zillow_url", "")
        if zillow_url:
            _assert_allowed_host(zillow_url)
            try:
                async with httpx.AsyncClient(
                    follow_redirects=True, max_redirects=3, timeout=8.0,
                    event_hooks={"request": [_check_redirect]},
                ) as client:
                    resp = await client.get(
                        zillow_url,
                        headers={
                            "User-Agent": (
                                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                                "AppleWebKit/537.36 (KHTML, like Gecko) "
                                "Chrome/120.0.0.0 Safari/537.36"
                            ),
                            "Accept": "text/html,application/xhtml+xml",
                        },
                    )
                    if resp.status_code == 200:
                        m = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']', resp.text)
                        if not m:
                            m = re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']', resp.text)
                        if m:
                            url = m.group(1)
            except HTTPException:
                raise
            except Exception as exc:
                log.warning("assets.thumbnail_zillow_failed", asset_id=asset_id, error=str(exc))

    elif asset.category == "vehicle":
        # Wikipedia REST API for a car photo — host is hardcoded, no SSRF risk
        search_term = asset.name.replace(" ", "_")
        try:
            async with httpx.AsyncClient(timeout=6.0) as client:
                resp = await client.get(
                    f"https://en.wikipedia.org/api/rest_v1/page/summary/{search_term}",
                    headers={"User-Agent": "Paiso/1.0 (personal finance app)"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    url = data.get("thumbnail", {}).get("source")

                if not url:
                    search_resp = await client.get(
                        "https://en.wikipedia.org/api/rest_v1/page/summary/"
                        + "_".join(asset.name.split()[:3]),
                        headers={"User-Agent": "Paiso/1.0"},
                    )
                    if search_resp.status_code == 200:
                        data = search_resp.json()
                        url = data.get("thumbnail", {}).get("source")
        except Exception as exc:
            log.warning("assets.thumbnail_wikipedia_failed", asset_id=asset_id, error=str(exc))

    return {"url": _https_image_url(url)}


@router.post("/{asset_id}/thumbnail")
async def upload_asset_thumbnail(
    asset_id: int,
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Upload a custom thumbnail image for an asset."""
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user.id)
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    await check_rate(f"upload:asset_photo:{user.id}", max_calls=UPLOAD_RATE["asset_photo"])
    raw = await read_capped(file, ASSET_PHOTO_MAX_BYTES, "The photo")
    # The bytes decide the type and the stored extension, not the label the
    # browser put on the file or its name.
    mime = sniff_image(raw)
    if mime is None:
        raise HTTPException(status_code=400, detail="File must be an image (jpeg, png, webp, or gif)")
    ext = "jpg" if mime == "image/jpeg" else mime.removeprefix("image/")

    # The photo this one replaces does not count against the quota.
    meta = _parse_meta(asset)
    await check_storage_quota(db, user.id, len(raw) - int(meta.get("custom_thumbnail_bytes") or 0))

    # Delete old custom thumbnail if present
    old_thumb = _owned_thumb(asset, meta.get("custom_thumbnail"))
    if old_thumb:
        await get_storage().delete(_thumb_key(old_thumb))

    filename = f"{user.id}_{asset_id}_{uuid.uuid4().hex[:8]}.{ext}"
    await get_storage().put(_thumb_key(filename), raw)

    meta["custom_thumbnail"] = filename
    meta["custom_thumbnail_bytes"] = len(raw)
    asset.metadata_json = json.dumps(meta)
    await db.commit()

    data_url = f"data:{mime};base64,{base64.b64encode(raw).decode()}"
    return {"url": data_url}


@router.delete("/{asset_id}/thumbnail", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset_thumbnail(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Remove the custom uploaded thumbnail for an asset."""
    asset = await db.scalar(
        select(Asset).where(Asset.id == asset_id, Asset.user_id == user.id)
    )
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    meta = _parse_meta(asset)
    meta.pop("custom_thumbnail_bytes", None)
    filename = meta.pop("custom_thumbnail", None)
    if filename is not None:
        # Only delete a storage object when the stored name is safe; an unsafe
        # legacy value is dropped from metadata without touching the disk (a
        # client could otherwise have aimed the delete at another user's file).
        safe = _owned_thumb(asset, filename)
        if safe:
            await get_storage().delete(_thumb_key(safe))
        asset.metadata_json = json.dumps(meta)
        await db.commit()

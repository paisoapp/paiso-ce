"""Shared guards for user uploads.

Every upload endpoint reads its file with :func:`read_capped`, which stops at
the limit instead of reading the whole file and checking its size after.
Image uploads are checked with :func:`sniff_image`, which reads the file's
first bytes rather than trusting the type the browser declared. The limits
themselves live here.

``BodyLimitMiddleware`` (``app/core/body_limit.py``) refuses a request body
over 30 MB before a route sees it, so a multipart body is never spooled to
disk past that.
"""
import re

from fastapi import HTTPException, UploadFile

MB = 1024 * 1024

# Per-file limits. Each is "under N MB": a file of exactly N MB is refused.
AVATAR_MAX_BYTES = 1 * MB            # profile photo (the client sends ~512 px)
RECEIPT_MAX_BYTES = 5 * MB           # each transaction attachment
ASSET_PHOTO_MAX_BYTES = 5 * MB       # property and other asset photos
STATEMENT_MAX_BYTES = 10 * MB        # each OFX, QFX or QBO statement
CSV_MAX_BYTES = 5 * MB               # each CSV import

# Counts and totals.
RECEIPTS_PER_TRANSACTION = 10
# Data rows in one CSV import, after the header.
CSV_MAX_ROWS = 1000
# Receipts and asset photos together, per user.
USER_STORAGE_QUOTA_BYTES = 250 * MB

# Uploads per user per five minutes, by kind, for check_rate.
UPLOAD_RATE = {
    "avatar": 10,
    "receipt": 30,
    "asset_photo": 20,
    "import": 30,
}

_CHUNK = 64 * 1024


def _mb(n: int) -> str:
    return f"{n // MB} MB"


def too_large(what: str, max_bytes: int) -> HTTPException:
    return HTTPException(status_code=413, detail=f"{what} must be under {_mb(max_bytes)}.")


async def read_capped(file: UploadFile, max_bytes: int, what: str = "The file") -> bytes:
    """Read an upload in chunks, refusing it with 413 once it reaches
    `max_bytes`. Never holds more than `max_bytes` plus one chunk in memory."""
    buf = bytearray()
    while chunk := await file.read(_CHUNK):
        buf.extend(chunk)
        if len(buf) >= max_bytes:
            raise too_large(what, max_bytes)
    return bytes(buf)


def require_csv_rows(raw: bytes) -> None:
    """Refuse a CSV with more than ``CSV_MAX_ROWS`` data rows with 413.

    Counts non-blank records after the first, with the csv module so a
    quoted newline inside a field does not count twice. A bank export with
    a few preamble lines counts them as rows too, which only matters within
    a few rows of the cap."""
    import csv
    import io

    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1", errors="replace")
    records = (r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r))
    next(records, None)  # the header
    for count, _ in enumerate(records, start=1):
        if count > CSV_MAX_ROWS:
            raise HTTPException(
                status_code=413,
                detail=f"A CSV file can hold up to {CSV_MAX_ROWS:,} transactions. "
                       "Split it into smaller files and import each one.",
            )


# The image formats the app accepts, by their first bytes.
def sniff_image(raw: bytes) -> str | None:
    """The image type `raw` really is (PNG, JPEG, WebP or GIF), or None."""
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp"
    if raw[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


_HEIC_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"mif1", b"msf1", b"hevc"}


def sniff_receipt(raw: bytes) -> str | None:
    """The type of a receipt attachment: an image (HEIC included, which is
    what an iPhone takes) or a PDF, by its first bytes; None for anything
    else."""
    if image := sniff_image(raw):
        return image
    if raw.startswith(b"%PDF-"):
        return "application/pdf"
    if raw[4:8] == b"ftyp" and raw[8:12] in _HEIC_BRANDS:
        return "image/heic"
    return None


_DATA_URI = re.compile(r"data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]*)\Z")

async def storage_used(db, user_id: int) -> int:
    """Bytes this user holds in receipts and asset photos.

    An asset photo saved before its size was recorded counts as the largest
    one allowed, so a row that lost its size cannot hide from the quota."""
    import json

    from sqlalchemy import func, select

    from app.models.asset import Asset
    from app.models.transaction import TransactionAttachment

    receipts = await db.scalar(
        select(func.coalesce(func.sum(TransactionAttachment.size_bytes), 0))
        .where(TransactionAttachment.user_id == user_id)
    ) or 0
    photos = 0
    for meta_json in (await db.scalars(
        select(Asset.metadata_json).where(
            Asset.user_id == user_id, Asset.metadata_json.like('%"custom_thumbnail"%')
        )
    )).all():
        try:
            meta = json.loads(meta_json)
        except ValueError:
            continue
        if not meta.get("custom_thumbnail"):
            continue
        size = meta.get("custom_thumbnail_bytes")
        ok = isinstance(size, int) and 0 < size <= ASSET_PHOTO_MAX_BYTES
        photos += size if ok else ASSET_PHOTO_MAX_BYTES
    return int(receipts) + photos


async def check_storage_quota(db, user_id: int, adding: int) -> None:
    """Refuse with 413 when `adding` more bytes would take this user past
    ``USER_STORAGE_QUOTA_BYTES``. A negative `adding` (a smaller replacement)
    always passes."""
    if adding <= 0:
        return
    if await storage_used(db, user_id) + adding > USER_STORAGE_QUOTA_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Your files have reached the {_mb(USER_STORAGE_QUOTA_BYTES)} limit. "
                   "Delete some receipts or photos to make room.",
        )

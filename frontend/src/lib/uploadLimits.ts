/** Upload limits, the same numbers as backend/app/core/uploads.py.
 *  The server enforces them; these let a screen say so before sending. */

const MB = 1024 * 1024;

export const UPLOAD_LIMITS = {
  receipt: 5 * MB,
  assetPhoto: 5 * MB,
  statement: 10 * MB,
  csv: 5 * MB,
} as const;

/** Receipts are photos or PDFs. */
export const RECEIPT_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,.heic,application/pdf,.pdf";

/** A message when `file` is at or over `max`, else null. */
export function tooLarge(file: File, max: number, what = "The file"): string | null {
  return file.size >= max ? `${what} must be under ${max / MB} MB.` : null;
}

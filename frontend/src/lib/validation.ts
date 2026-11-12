/**
 * Client-side mirrors of `backend/app/core/validation.py`, so a
 * form can say what's wrong before the request is sent. The backend enforces
 * the same rules regardless; keep the two in step.
 */

const MAX_AGE = 120;
/** Nothing a user enters predates this (matches the API's EARLIEST_DATE). */
export const EARLIEST_DATE = "1900-01-01";
/** Minimum age to hold a Paiso account (the "self" profile). */
export const MIN_ACCOUNT_HOLDER_AGE = 18;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Local-calendar YYYY-MM-DD (not UTC — `toISOString` is tomorrow by evening in the US). */
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayIso(): string {
  return isoDate(new Date());
}

/** A YYYY-MM-DD date from the API as a local-calendar date. `new Date(iso)`
 *  reads it as UTC midnight, which is the evening before anywhere in the
 *  Americas, so June 1 showed as "May". */
export function parseLocalDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return isoDate(d);
}

/** `min` / `max` for a date-of-birth `<input type="date">`. */
export function dobBounds(minAge = 0): { min: string; max: string } {
  return { min: yearsAgoIso(MAX_AGE), max: minAge ? yearsAgoIso(minAge) : todayIso() };
}

/** Why a date of birth can't be saved, or null if it's blank or fine. */
export function dobError(value: string, { minAge = 0 }: { minAge?: number } = {}): string | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    return "Enter a valid date.";
  }
  const { min } = dobBounds();
  if (value > todayIso()) return "Date of birth cannot be in the future.";
  if (value < min) return `Date of birth must be within the last ${MAX_AGE} years.`;
  if (minAge && value > yearsAgoIso(minAge)) {
    return `You must be at least ${minAge} years old to use Paiso.`;
  }
  return null;
}

/** Longest account name (matches the API's MAX_ACCOUNT_NAME). */
export const ACCOUNT_NAME_MAX = 100;

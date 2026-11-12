/**
 * One way to write a date across the app. Before, the same day read
 * "10/9/2026" in one place, "10/09/2026" in another and "Oct 9" in a third.
 *
 *  - formatDate        Oct 9, 2026           tables, drawers, sentences
 *  - formatDateTime    Oct 9, 2026, 3:04 PM  audit trails, sync times
 *  - formatShortDate   Oct 9                 when the year is obvious
 *  - formatMonth       Oct 2026              a month on its own
 *  - formatAxisDate    Oct 9 / Oct ’26       chart axes, by the span shown
 *
 * A bare "YYYY-MM-DD" is a calendar day, not an instant: it is read in local
 * time, so it never shows as the day before west of UTC.
 */
type DateLike = string | number | Date;

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_ONLY = /^\d{4}-\d{2}$/;

function parseDate(value: DateLike): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    if (DAY_ONLY.test(value)) {
      const [y, m, d] = value.split("-").map(Number);
      return new Date(y, m - 1, d);
    }
    if (MONTH_ONLY.test(value)) {
      const [y, m] = value.split("-").map(Number);
      return new Date(y, m - 1, 1);
    }
  }
  return new Date(value);
}

function fmt(value: DateLike | null | undefined, options: Intl.DateTimeFormatOptions, empty: string): string {
  if (value == null || value === "") return empty;
  const d = parseDate(value);
  return Number.isNaN(d.getTime()) ? empty : d.toLocaleString("en-US", options);
}

export function formatDate(value: DateLike | null | undefined, empty = "—"): string {
  return fmt(value, { month: "short", day: "numeric", year: "numeric" }, empty);
}

export function formatDateTime(value: DateLike | null | undefined, empty = "—"): string {
  return fmt(value, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }, empty);
}

export function formatShortDate(value: DateLike | null | undefined, empty = "—"): string {
  return fmt(value, { month: "short", day: "numeric" }, empty);
}

/** "Oct ’26": a month on a crowded axis. "Oct 26" alone reads as a day. */
export function formatMonthShort(value: DateLike | null | undefined, empty = ""): string {
  if (value == null || value === "") return empty;
  const d = parseDate(value);
  if (Number.isNaN(d.getTime())) return empty;
  return `${d.toLocaleString("en-US", { month: "short" })} ’${String(d.getFullYear()).slice(-2)}`;
}

/** A chart's x-axis label: the day while the chart covers under a year,
 *  the month and year once it spans more. */
export function formatAxisDate(value: DateLike, spanDays: number): string {
  return spanDays > 370 ? formatMonthShort(value) : formatShortDate(value, "");
}

/** Days between the first and last of a date-ordered series. */
export function spanInDays(first: DateLike | undefined, last: DateLike | undefined): number {
  if (first == null || last == null) return 0;
  return Math.abs(parseDate(last).getTime() - parseDate(first).getTime()) / 86_400_000;
}

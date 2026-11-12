import { useEffect, useState } from "react";
import { CalendarDays, ChevronDown } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { Button } from "./button";

export interface DateRange {
  from: string;
  to: string;
}

/**
 * What to compare the selected range against. The first two are relative to
 * that range and follow it: pick another month and the comparison moves with
 * it, where a fixed pair of dates would be left comparing against the wrong
 * period.
 */
export type CompareSelection =
  | { kind: "previous" }
  | { kind: "year" }
  | { kind: "custom"; from: string; to: string };

interface Props {
  value: DateRange | null;
  onChange: (range: DateRange | null) => void;
  /** Pass `onCompareChange` to offer a comparison period. */
  compare?: CompareSelection | null;
  onCompareChange?: (compare: CompareSelection | null) => void;
  /** When provided, an "All time" preset button is shown that calls this. */
  onClearAll?: () => void;
  /** Text shown when value is null. Defaults to "All time". */
  placeholder?: string;
  className?: string;
}

const PRESETS = [
  { label: "Today",          getDates: () => today() },
  { label: "This week",      getDates: () => thisWeek() },
  { label: "Last week",      getDates: () => lastWeek() },
  { label: "Last 30 days",   getDates: () => lastNDays(30) },
  { label: "This month",     getDates: () => thisMonth() },
  { label: "Last month",     getDates: () => lastMonth() },
  { label: "Last 3 months",  getDates: () => lastNMonths(3) },
  { label: "Last 6 months",  getDates: () => lastNMonths(6) },
  { label: "Last 12 months", getDates: () => lastNMonths(12) },
  { label: "This year",      getDates: () => thisYear() },
  { label: "Last year",      getDates: () => lastYear() },
];

export function defaultRange(): DateRange {
  return lastNMonths(3);
}

export function todayISO(): string {
  return fmt(new Date());
}

/** How a range reads in a sentence: its preset name, else its dates. */
export function describeRange(value: DateRange | null): string {
  if (value === null) return "All time";
  return getPresetLabel(value) ?? `${value.from} → ${value.to}`;
}

export function getPresetLabel(value: DateRange): string | null {
  for (const p of PRESETS) {
    const d = p.getDates();
    if (d.from === value.from && d.to === value.to) return p.label;
  }
  return null;
}

/** Recompute a preset's absolute range from its label (fresh for "today"). */
export function resolvePresetLabel(label: string): DateRange | null {
  return PRESETS.find((p) => p.label === label)?.getDates() ?? null;
}

function pad(n: number) { return String(n).padStart(2, "0"); }
function fmt(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function today(): DateRange {
  const t = fmt(new Date());
  return { from: t, to: t };
}

function thisWeek(): DateRange {
  const now = new Date();
  const diff = now.getDay() === 0 ? 6 : now.getDay() - 1; // days since Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  return { from: fmt(monday), to: fmt(now) };
}

function lastWeek(): DateRange {
  const now = new Date();
  const diff = now.getDay() === 0 ? 6 : now.getDay() - 1;
  const lastMonday = new Date(now);
  lastMonday.setDate(now.getDate() - diff - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  return { from: fmt(lastMonday), to: fmt(lastSunday) };
}

function lastNDays(n: number): DateRange {
  const now = new Date();
  const from = new Date(now);
  from.setDate(now.getDate() - n);
  return { from: fmt(from), to: fmt(now) };
}

function thisMonth(): DateRange {
  const now = new Date();
  return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(now) };
}

function lastMonth(): DateRange {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const last = new Date(now.getFullYear(), now.getMonth(), 0);
  return { from: fmt(first), to: fmt(last) };
}

function lastNMonths(n: number): DateRange {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - n + 1, 1);
  return { from: fmt(from), to: fmt(now) };
}

function thisYear(): DateRange {
  const now = new Date();
  return { from: fmt(new Date(now.getFullYear(), 0, 1)), to: fmt(now) };
}

function lastYear(): DateRange {
  const now = new Date();
  const y = now.getFullYear() - 1;
  return { from: `${y}-01-01`, to: `${y}-12-31` };
}

function parse(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

function isMonthEnd(d: Date): boolean {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getDate() === 1;
}

/** Move a date by whole months. A month-end stays a month-end (Sep 30 → Aug
 *  31), and a day the target month lacks is pulled back to its last one. */
function shiftMonths(iso: string, months: number): string {
  const d = parse(iso);
  const lastOfTarget = new Date(d.getFullYear(), d.getMonth() + months + 1, 0);
  const day = isMonthEnd(d) ? lastOfTarget.getDate() : Math.min(d.getDate(), lastOfTarget.getDate());
  return fmt(new Date(lastOfTarget.getFullYear(), lastOfTarget.getMonth(), day));
}

/**
 * The period just before `range`, like for like.
 *
 * A range that starts on the 1st is a run of calendar months, so it steps back
 * by that many months: this month to date against the same days of last month,
 * September against August. Counting days instead would set Oct 1–6 against
 * Sep 25–30, and payday against rent day. A range that starts on Jan 1 steps
 * back a year, since the ten months before a year-to-date are not its peer.
 * Anything else steps back by its own length in days.
 */
function previousPeriod(range: DateRange): DateRange {
  const from = parse(range.from);
  const to = parse(range.to);
  if (from.getDate() === 1) {
    const months = (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth() + 1;
    const back = from.getMonth() === 0 && months <= 12 ? 12 : months;
    return { from: shiftMonths(range.from, -back), to: shiftMonths(range.to, -back) };
  }
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1);
  const prevFrom = new Date(prevTo.getFullYear(), prevTo.getMonth(), prevTo.getDate() - days + 1);
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

/** The dates a comparison stands for, given the range it is compared with.
 *  `null` when there is nothing to compare: no selection, or "All time". */
export function resolveCompare(compare: CompareSelection | null | undefined, range: DateRange | null): DateRange | null {
  if (!compare) return null;
  if (compare.kind === "custom") return { from: compare.from, to: compare.to };
  if (range === null) return null;
  if (compare.kind === "year") return { from: shiftMonths(range.from, -12), to: shiftMonths(range.to, -12) };
  return previousPeriod(range);
}

/** "Sep 1 – Sep 30, 2026"; the first year is dropped when both share one. */
export function formatRangeDates(r: DateRange): string {
  const from = parse(r.from);
  const to = parse(r.to);
  const sameYear = from.getFullYear() === to.getFullYear();
  const long: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const start = from.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : long);
  return r.from === r.to ? to.toLocaleDateString([], long) : `${start} – ${to.toLocaleDateString([], long)}`;
}

const COMPARE_OPTIONS: { kind: "previous" | "year"; label: string }[] = [
  { kind: "previous", label: "Previous period" },
  { kind: "year", label: "Same period last year" },
];

export function DateRangePicker({ value, onChange, compare, onCompareChange, onClearAll, placeholder = "All time", className }: Props) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  const compareRange = resolveCompare(compare, value);

  // Same draft treatment as the main custom range below.
  const [compareDraft, setCompareDraft] = useState<DateRange>({ from: "", to: "" });
  const [customCompareOpen, setCustomCompareOpen] = useState(compare?.kind === "custom");
  useEffect(() => {
    if (!open) return;
    setCustomCompareOpen(compare?.kind === "custom");
    // Start the custom inputs from the dates on screen, so adjusting a quick
    // pick by a few days does not mean typing both dates from scratch.
    setCompareDraft(compareRange ?? { from: "", to: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const compareDraftBackwards = !!compareDraft.from && !!compareDraft.to && compareDraft.from > compareDraft.to;
  const editCompareDraft = (next: DateRange) => {
    setCompareDraft(next);
    if (next.from && next.to && next.from <= next.to) onCompareChange?.({ kind: "custom", ...next });
  };

  // The custom inputs edit a draft. Each keystroke used to go straight to
  // `onChange`, so a half-typed range ("from" set, "to" still blank) was sent
  // to the API as an open-ended one — and, now that ranges are remembered,
  // would have been saved as the user's preference.
  const [draft, setDraft] = useState<DateRange>({ from: value?.from ?? "", to: value?.to ?? "" });
  useEffect(() => {
    if (open) setDraft({ from: value?.from ?? "", to: value?.to ?? "" });
  }, [open, value?.from, value?.to]);
  const draftBackwards = !!draft.from && !!draft.to && draft.from > draft.to;
  const editDraft = (next: DateRange) => {
    setDraft(next);
    if (next.from && next.to && next.from <= next.to) onChange(next);
  };

  const presetLabel = value ? getPresetLabel(value) : null;
  const label = presetLabel ?? (value ? `${value.from} → ${value.to}` : placeholder);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Date range: ${label}${presetLabel && value ? `, ${formatRangeDates(value)}` : ""}`}
        title={presetLabel && value ? formatRangeDates(value) : undefined}
        className="flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted transition-colors"
      >
        <CalendarDays size={14} className="shrink-0 text-muted-foreground" />
        <span className="truncate">{label}</span>
        {/* A preset's name and its actual dates: "Last 3 months" means this
            month so far plus the two before it, which is worth seeing. */}
        {presetLabel && value && (
          <span className="hidden lg:inline text-xs text-muted-foreground whitespace-nowrap">
            {formatRangeDates(value)}
          </span>
        )}
        {compareRange && <span className="hidden sm:inline text-xs text-muted-foreground">vs {formatRangeDates(compareRange)}</span>}
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div
            className={cn("fixed inset-0", isMobile ? "z-40 bg-black/40" : "z-10")}
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Choose a date range"
            className={cn(
              "rounded-xl border border-border bg-card shadow-xl p-4 space-y-4",
              isMobile
                ? "fixed inset-x-0 bottom-0 z-50 rounded-b-none border-x-0 border-b-0 max-h-[85dvh] overflow-y-auto pb-[calc(1rem+env(safe-area-inset-bottom))]"
                : "absolute right-0 top-full mt-1 z-20 w-80 max-w-[calc(100vw-1rem)]",
            )}
          >
            {/* Presets */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Quick select</p>
              <div className="grid grid-cols-2 gap-1">
                {onClearAll && (
                  <button
                    type="button"
                    onClick={() => { onClearAll(); setOpen(false); }}
                    className={cn(
                      "col-span-2 rounded-md px-2 py-1.5 text-xs text-left transition-colors",
                      value === null
                        ? "bg-primary/10 text-primary font-medium"
                        : "hover:bg-muted"
                    )}
                  >
                    All time
                  </button>
                )}
                {PRESETS.map((p) => {
                  const d = p.getDates();
                  const isActive = value?.from === d.from && value?.to === d.to;
                  return (
                    <button
                      type="button"
                      key={p.label}
                      onClick={() => { onChange(p.getDates()); setOpen(false); }}
                      className={cn(
                        "rounded-md px-2 py-1.5 text-xs text-left transition-colors",
                        isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
                      )}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Custom range */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Custom range</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-xs text-muted-foreground">From</label>
                  <input
                    type="date"
                    value={draft.from}
                    max={draft.to || undefined}
                    onChange={(e) => editDraft({ ...draft, from: e.target.value })}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">To</label>
                  <input
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    onChange={(e) => editDraft({ ...draft, to: e.target.value })}
                    className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                </div>
              </div>
              {draftBackwards && (
                <p className="mt-1.5 text-xs text-destructive">The start date is after the end date.</p>
              )}
            </div>

            {/* Compare — quick picks first, so the common comparisons need no typing */}
            {onCompareChange && (
              <div className="border-t border-border pt-3 space-y-2">
                <label className={cn("flex items-center gap-2 text-sm", value === null ? "text-muted-foreground" : "cursor-pointer")}>
                  <input
                    type="checkbox"
                    checked={!!compare}
                    disabled={value === null && !compare}
                    onChange={(e) => onCompareChange(e.target.checked ? { kind: "previous" } : null)}
                  />
                  Compare to an earlier period
                </label>
                {value === null && !compare && (
                  <p className="text-xs text-muted-foreground">Pick a date range first: all time has nothing before it.</p>
                )}
                {compare && (
                  <div className="space-y-1">
                    {value !== null && COMPARE_OPTIONS.map((o) => {
                      const dates = resolveCompare({ kind: o.kind }, value);
                      const isActive = compare.kind === o.kind;
                      return (
                        <button
                          type="button"
                          key={o.kind}
                          onClick={() => { onCompareChange({ kind: o.kind }); setCustomCompareOpen(false); }}
                          className={cn(
                            "flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-xs text-left transition-colors",
                            isActive ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted",
                          )}
                        >
                          <span>{o.label}</span>
                          {dates && <span className={cn("tabular-nums", !isActive && "text-muted-foreground")}>{formatRangeDates(dates)}</span>}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setCustomCompareOpen((v) => !v)}
                      aria-expanded={customCompareOpen}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-xs text-left transition-colors",
                        compare.kind === "custom" ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted",
                      )}
                    >
                      <span>Custom dates</span>
                      <ChevronDown size={12} className={cn("transition-transform", customCompareOpen && "rotate-180")} />
                    </button>
                    {customCompareOpen && (
                      <div className="px-2 pt-1">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-xs text-muted-foreground">From</label>
                            <input
                              type="date"
                              value={compareDraft.from}
                              max={compareDraft.to || undefined}
                              onChange={(e) => editCompareDraft({ ...compareDraft, from: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-muted-foreground">To</label>
                            <input
                              type="date"
                              value={compareDraft.to}
                              min={compareDraft.from || undefined}
                              onChange={(e) => editCompareDraft({ ...compareDraft, to: e.target.value })}
                              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50"
                            />
                          </div>
                        </div>
                        {compareDraftBackwards && (
                          <p className="mt-1.5 text-xs text-destructive">The start date is after the end date.</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <Button type="button" size="sm" className="w-full" onClick={() => setOpen(false)}>
              Apply
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

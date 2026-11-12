import { Info } from "@/lib/icons";
import { cn } from "@/lib/utils";
import {
  type DateRange,
  defaultRange,
  describeRange,
  getPresetLabel,
} from "@/components/ui/DateRangePicker";
import type { WidenedRange } from "@/hooks/useSectionDateRange";

function shortDate(iso: string) {
  return new Date(iso + "T00:00:00").toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

/** A range as it reads mid-sentence: "this month", "in the last 3 months". */
function inWords(r: DateRange | null): string {
  if (r === null) return "at any time";
  const label = getPresetLabel(r);
  if (!label) return `between ${shortDate(r.from)} and ${shortDate(r.to)}`;
  return /^Last \d/.test(label) ? `in the ${label.toLowerCase()}` : label.toLowerCase();
}

/** The same, as the thing being shown: "the last 3 months", "everything". */
function asShown(r: DateRange | null): string {
  if (r === null) return "everything";
  const label = getPresetLabel(r);
  if (!label) return `${shortDate(r.from)} to ${shortDate(r.to)}`;
  return /^Last \d/.test(label) ? `the ${label.toLowerCase()}` : label.toLowerCase();
}

function Shell({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3.5 py-2.5 text-sm",
        className,
      )}
      role="status"
    >
      <Info size={16} className="shrink-0 text-primary" />
      {children}
    </div>
  );
}

const actionCls = "text-sm font-medium text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded";

/**
 * Says that the page is showing a wider range than the one selected, and why —
 * see useAutoWidenRange. The way back is one click, and it sticks.
 */
export function RangeWidenedNotice({ widen, className }: { widen: WidenedRange; className?: string }) {
  if (!widen.widenedFrom) return null;
  return (
    <Shell className={className}>
      <p className="flex-1 min-w-[12rem] text-muted-foreground">
        There is nothing {inWords(widen.widenedFrom)} yet, so this is showing{" "}
        <span className="font-medium text-foreground">{asShown(widen.range)}</span> instead.
      </p>
      <button type="button" className={actionCls} onClick={widen.showSelected}>
        Show {describeRange(widen.widenedFrom).toLowerCase()} anyway
      </button>
    </Shell>
  );
}

/**
 * Shown when the range the user asked for is empty and the page has stayed on
 * it. Offers the default range rather than switching to it. Renders nothing
 * for "All time", where emptiness means there is no data at all.
 */
export function RangeEmptyHint({
  show,
  range,
  onPick,
  className,
}: {
  show: boolean;
  range: DateRange | null;
  onPick: (r: DateRange) => void;
  className?: string;
}) {
  if (!show || range === null) return null;
  const wider = defaultRange();
  const canWiden = wider.from < range.from;
  return (
    <Shell className={className}>
      <p className="flex-1 min-w-[12rem] text-muted-foreground">There is nothing {inWords(range)}.</p>
      {canWiden && (
        <button type="button" className={actionCls} onClick={() => onPick(wider)}>
          Show {asShown(wider)}
        </button>
      )}
    </Shell>
  );
}

/**
 * Says why a daily tab's picker shows "Last 30 days" when the user picked a
 * shorter range (see useDailySectionRange). The picker itself names the range
 * on screen; this line only explains the switch, and goes with the next pick.
 */
export function DailyRangeHint({ replaced, what, className }: { replaced: DateRange | null; what: string; className?: string }) {
  if (!replaced) return null;
  const label = getPresetLabel(replaced);
  return (
    <p role="status" className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}>
      <Info size={12} className="shrink-0" />
      {what} update once a day, so {label ? `"${label}"` : "a range that short"} would show a single point.
      We selected the last 30 days for you.
    </p>
  );
}

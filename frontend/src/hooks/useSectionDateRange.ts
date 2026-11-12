import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import {
  type DateRange,
  defaultRange,
  resolvePresetLabel,
  todayISO,
} from "@/components/ui/DateRangePicker";
import {
  type DateRangeSection,
  rangeToStored,
  storedToRange,
  useUiPrefsStore,
} from "@/store/uiPrefs";

function rangeKey(r: DateRange | null): string {
  return r ? `${r.from}|${r.to}` : "all";
}

// Ranges the user picked by hand during this session, per section. A picked
// range is shown as picked even when it is empty — see useAutoWidenRange. Kept
// in memory only: after a reload the remembered range is a preference again
// rather than something just asked for, and may be widened once more.
const useRangePins = create<{
  pins: Partial<Record<DateRangeSection, string>>;
  pin: (section: DateRangeSection, r: DateRange | null) => void;
}>((set) => ({
  pins: {},
  pin: (section, r) => set((s) => ({ pins: { ...s.pins, [section]: rangeKey(r) } })),
}));

/**
 * The date range for one section of the app: three months until the user picks
 * something else, and after that whatever they last picked there — across tabs,
 * sessions and devices.
 */
export function useSectionDateRange(section: DateRangeSection) {
  const stored = useUiPrefsStore((s) => s.dateRanges[section]);
  const setStored = useUiPrefsStore((s) => s.setSectionDateRange);
  const pin = useRangePins((s) => s.pin);

  // Presets are stored by name and resolved here, so "Last 3 months" keeps
  // ending today instead of on the day it was chosen.
  const dateRange = useMemo(
    () => (stored ? storedToRange(stored) : defaultRange()),
    [stored],
  );
  const setDateRange = useCallback(
    (r: DateRange | null) => {
      setStored(section, rangeToStored(r));
      pin(section, r);
    },
    [section, setStored, pin],
  );

  return { dateRange, setDateRange };
}

/** Shorter than this, a range of once-a-day values is a dot or two. */
const DAILY_MIN_DAYS = 7;
/** What a daily tab switches to instead. */
const DAILY_FALLBACK_LABEL = "Last 30 days";

function tooShortForDaily(r: DateRange | null): boolean {
  return !!r && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 < DAILY_MIN_DAYS;
}

/**
 * A section's range on a tab whose values change once a day: retirement,
 * education and health plans, and the Investments overview. There,
 * "Today" or "This week" would draw a single dot, so picking one selects
 * "Last 30 days" in the picker instead, and `replaced` holds the pick it
 * stood in for until the next pick, for the hint that says why. A short range
 * saved before this rule is switched the same way when the tab opens.
 *
 * With `enabled` false it is useSectionDateRange and nothing more.
 */
export function useDailySectionRange(section: DateRangeSection, enabled = true) {
  const { dateRange, setDateRange } = useSectionDateRange(section);
  const [replaced, setReplaced] = useState<DateRange | null>(null);

  const setRange = useCallback(
    (r: DateRange | null) => {
      if (enabled && tooShortForDaily(r)) {
        setReplaced(r);
        setDateRange(resolvePresetLabel(DAILY_FALLBACK_LABEL));
      } else {
        setReplaced(null);
        setDateRange(r);
      }
    },
    [enabled, setDateRange],
  );

  useEffect(() => {
    if (enabled && tooShortForDaily(dateRange)) setRange(dateRange);
  }, [enabled, dateRange, setRange]);

  return { dateRange, setDateRange: setRange, replaced: enabled ? replaced : null };
}

/** Wider ranges to fall back on, nearest first; `null` is all time. */
function widerRanges(selected: DateRange | null): (DateRange | null)[] {
  // All time cannot be widened. A range that ended in the past is a period
  // someone went looking for, and "nothing happened then" is its answer.
  if (selected === null || selected.to < todayISO()) return [];
  const steps = ["Last 3 months", "Last 12 months"]
    .map(resolvePresetLabel)
    .filter((r): r is DateRange => r !== null && r.from < selected.from);
  return [...steps, null];
}

export interface WidenedRange {
  /** The range to query and display. */
  range: DateRange | null;
  /** The range the user asked for, when `range` is a wider stand-in for it. */
  widenedFrom: DateRange | null;
  /** Go back to the range the user asked for, and stay there. */
  showSelected: () => void;
  /** Internal — see useWidenWhenEmpty. */
  step: (emptyRange: DateRange | null) => void;
  canStep: boolean;
}

/**
 * Stands a wider range in for one that has nothing in it.
 *
 * A page that opens on an empty period looks broken, and the usual cause is
 * dull: the month has only just started, or the latest import stops short of
 * it. So when the section's range comes back empty the page shows the last
 * three months instead — then twelve, then everything — and says that it did.
 *
 * What it will not do is argue with the user. The stand-in is never saved, so
 * the range they chose is still their preference and returns by itself once it
 * has data. A range picked by hand this session is shown as picked, empty or
 * not. And "Show this month" on the notice sticks until they pick again.
 *
 * `scope` names whatever else narrows the data (an account filter, say): a
 * change there starts over, since the wider range was chosen for the old scope.
 */
export function useAutoWidenRange(
  section: DateRangeSection,
  selected: DateRange | null,
  scope = "",
): WidenedRange {
  const pinnedKey = useRangePins((s) => s.pins[section]);
  const pin = useRangePins((s) => s.pin);

  const key = `${rangeKey(selected)}#${scope}`;
  const [state, setState] = useState({ key, step: -1, exhausted: false });
  // A new selection or scope starts from the selected range again. Derived
  // rather than reset in an effect, so the stale stand-in is never rendered.
  const current = state.key === key ? state : { key, step: -1, exhausted: false };

  const candidates = useMemo(() => widerRanges(selected), [selected]);
  const pinned = pinnedKey === rangeKey(selected);
  const widened = !pinned && !current.exhausted && current.step >= 0;

  const step = useCallback((emptyRange: DateRange | null) => {
    setState((prev) => {
      const base = prev.key === key ? prev : { key, step: -1, exhausted: false };
      // Only the range currently on screen can move things along. A report
      // about one already stepped past (a doubled effect, a late render) would
      // otherwise skip a rung.
      const shown = base.step >= 0 ? candidates[base.step] : selected;
      if (rangeKey(shown) !== rangeKey(emptyRange)) return prev;
      // Every wider range was empty too: there is simply no data, so show the
      // range that was asked for and let the page's own empty state speak.
      if (base.step + 1 >= candidates.length) return { ...base, exhausted: true };
      return { ...base, step: base.step + 1 };
    });
  }, [key, candidates, selected]);

  return {
    range: widened ? candidates[current.step] : selected,
    widenedFrom: widened ? selected : null,
    showSelected: () => pin(section, selected),
    step,
    canStep: !pinned && !current.exhausted && candidates.length > 0,
  };
}

/**
 * Tells useAutoWidenRange what its range turned up. Separate from it because
 * the page's query sits between the two: it needs the range first, and only
 * then knows whether that range was empty.
 */
export function useWidenWhenEmpty(
  widen: WidenedRange,
  { isLoading, isEmpty }: { isLoading: boolean; isEmpty: boolean },
) {
  const { step, canStep, range } = widen;
  useEffect(() => {
    if (!isLoading && isEmpty && canStep) step(range);
  }, [isLoading, isEmpty, canStep, step, range]);
}

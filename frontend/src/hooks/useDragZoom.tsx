// dashboard-catalog: not offered, a hook that charts use, not a chart.
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ReferenceArea } from "recharts";
import type { DateRange } from "@/components/ui/DateRangePicker";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { RotateCcw } from "@/lib/icons";

/** What Recharts hands a chart's mouse handlers; only the label is needed. */
type ChartMouse = { activeLabel?: string | number } | null | undefined;

const day = (v: string) => v.slice(0, 10);

/**
 * Drag across a date chart to zoom into that stretch.
 *
 * Pressing on the chart starts a shaded band; releasing sets the band's dates
 * as the chart's range, through the same setter the date picker uses, so the
 * zoom is remembered and the picker shows it. "Reset zoom" puts back the range
 * from before the first zoom. Ranges are whole days, so a drag inside one day
 * (an intraday chart) does nothing.
 *
 * Off on phones, where a drag scrolls the page. The chart's x-axis must be ISO
 * dates or timestamps (`dataKey="date"`).
 *
 * Use: spread `chartProps` on the Recharts chart, put `area` inside it,
 * spread `wrapperProps` on the element around it (it stops the click that ends
 * a drag from opening a clickable card), and show `resetButton` by the picker.
 */
export function useDragZoom({ range, setRange, enabled = true }: {
  range: DateRange | null;
  setRange: (r: DateRange | null) => void;
  enabled?: boolean;
}) {
  const isMobile = useIsMobile();
  const on = enabled && !isMobile;
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  // The range before the first zoom, and the range the last zoom set.
  const [before, setBefore] = useState<{ range: DateRange | null; zoomed: DateRange } | null>(null);
  const justZoomed = useRef(false);

  // Picking another range from the picker ends the zoom: there is nothing to
  // reset to any more.
  useEffect(() => {
    if (before && (range?.from !== before.zoomed.from || range?.to !== before.zoomed.to)) setBefore(null);
  }, [range?.from, range?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const clear = () => { setStart(null); setEnd(null); };
  const chartProps = on ? {
    onMouseDown: (e: ChartMouse) => {
      if (e?.activeLabel != null) { setStart(String(e.activeLabel)); setEnd(null); }
    },
    onMouseMove: (e: ChartMouse) => {
      if (start && e?.activeLabel != null) setEnd(String(e.activeLabel));
    },
    onMouseUp: () => {
      if (start && end) {
        const [a, b] = [start, end].sort();
        if (day(a) !== day(b)) {
          const zoomed = { from: day(a), to: day(b) };
          setBefore((prev) => ({ range: prev ? prev.range : range, zoomed }));
          justZoomed.current = true;
          setRange(zoomed);
        }
      }
      clear();
    },
    onMouseLeave: clear,
    style: { cursor: "crosshair", userSelect: "none" as const },
  } : {};

  const area = on && start && end ? (
    <ReferenceArea x1={start} x2={end} strokeOpacity={0} fill="hsl(var(--primary))" fillOpacity={0.12} />
  ) : null;

  const wrapperProps = {
    onClickCapture: (e: MouseEvent) => {
      if (justZoomed.current) { justZoomed.current = false; e.stopPropagation(); }
    },
  };

  const resetButton = before ? (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setRange(before.range); setBefore(null); }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50"
    >
      <RotateCcw size={12} /> Reset zoom
    </button>
  ) : null;

  return { chartProps, area, wrapperProps, resetButton, enabled: on };
}

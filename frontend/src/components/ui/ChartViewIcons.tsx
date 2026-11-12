import { BarChart2, LineChart } from "@/lib/icons";

/** A Sankey diagram in the same 24px line style as the icon set, which has
 *  none: two streams on the left merging and splitting into three. */
function SankeyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
    >
      <path d="M3 6h3c5 0 7 3 12 3h3" />
      <path d="M3 15h3c5 0 7-6 12-6" />
      <path d="M9 15c4 0 5 3 9 3h3" />
      <path d="M12 12c3 0 4 3 6 3h3" />
    </svg>
  );
}

/** The icon for each chart view, used when the toggle shows icons. */
export const CHART_VIEW_ICONS = {
  trend: LineChart,
  bars: BarChart2,
  sankey: SankeyIcon,
} as const;

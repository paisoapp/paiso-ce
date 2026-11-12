import { Link, useNavigate } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CardTitle, clickableCardClass } from "@/components/ui/card-link";
import { assetSlices } from "@/lib/assetColors";
import { assetClassHref, useCardClick } from "@/lib/navTargets";
import { formatCurrency, cn } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  opacity: 0.97,
};

/**
 * Asset breakdown donut with a labelled legend. Shared by the Portfolio page
 * and the Dashboard "Asset Mix" widget so both colour a slice the same way.
 *
 * The backend guarantees the slices sum to `total` (cash included), so the figure in the centre is the sum of what is drawn.
 *
 * Each slice and legend row opens the page where that money is managed; with
 * `to`, the rest of the card opens that page.
 */
export function AssetBreakdownDonut({
  breakdown,
  total,
  title = "Asset Breakdown",
  height = 220,
  className,
  to,
}: {
  breakdown: { label: string; value: number }[];
  total: number;
  title?: string;
  height?: number;
  className?: string;
  to?: string;
}) {
  // The palette has its own steps per surface; dark is chosen, not inverted.
  const dark = useIsDarkMode();
  const navigate = useNavigate();
  const onCardClick = useCardClick(to);
  // "Other" (folded slices) has no single home, so it gets no link.
  const hrefFor = (key: string) => (key === "other" ? undefined : assetClassHref(key));
  const slices = assetSlices(breakdown, dark);
  const sum = slices.reduce((s, b) => s + b.value, 0);

  return (
    <div
      onClick={to ? onCardClick : undefined}
      className={cn("rounded-xl border border-border bg-card p-4", to && clickableCardClass, className)}
    >
      <CardTitle title={title} to={to} className="mb-3" />
      {slices.length === 0 ? (
        <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
          No assets yet.
        </div>
      ) : (
        // A fixed-size donut and a legend that wraps below it whenever the card
        // is too narrow for both side by side — the card's width, not the
        // viewport's, decides (it sits in a 3-column grid on wide screens).
        <div className="flex flex-wrap items-center justify-center gap-4">
          <div className="relative shrink-0" style={{ height, width: height }}>
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius="58%"
                  outerRadius="92%"
                  stroke="hsl(var(--card))"
                  strokeWidth={2}
                  isAnimationActive={false}
                  onClick={(slice: { key?: string }, _i: number, e: React.MouseEvent) => {
                    const href = slice?.key ? hrefFor(slice.key) : undefined;
                    if (!href) return;
                    e?.preventDefault?.();
                    navigate(href);
                  }}
                >
                  {slices.map((b) => (
                    <Cell key={b.key} fill={b.color} className={b.key === "other" ? undefined : "cursor-pointer"} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v: number, name: string) => [
                    `${formatCurrency(v)} (${sum > 0 ? ((v / sum) * 100).toFixed(1) : "0"}%)`,
                    name,
                  ]}
                  contentStyle={tooltipStyle}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-center">
                <p className="text-sm font-bold text-foreground tabular-nums">{formatCurrency(total)}</p>
                <p className="text-[10px] text-muted-foreground">Total</p>
              </div>
            </div>
          </div>
          <ul className="flex-1 min-w-[13rem] space-y-1.5 text-xs">
            {slices.map((b) => {
              const href = hrefFor(b.key);
              const row = (
                <>
                  <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: b.color }} />
                  <span className="text-foreground truncate min-w-0">{b.label}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {sum > 0 ? ((b.value / sum) * 100).toFixed(1) : "0"}%
                  </span>
                  <span className="shrink-0 min-w-[4.5rem] text-right tabular-nums text-foreground whitespace-nowrap">{formatCurrency(b.value)}</span>
                </>
              );
              return (
                <li key={b.key}>
                  {href ? (
                    <Link to={href} className="flex items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-muted/60">{row}</Link>
                  ) : (
                    <div className="flex items-center gap-2 px-1 -mx-1 py-0.5">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

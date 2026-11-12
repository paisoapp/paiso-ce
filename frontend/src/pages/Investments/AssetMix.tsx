import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { neutral, slotColor } from "@/lib/chartPalette";
import { formatCurrency } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

/* What investments are invested in (asset class), drawn on the Overview
 * beside what they are for and how they are taxed. Colours: the shared,
 * validated categorical palette in the server's fixed asset-class order. */

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  opacity: 0.97,
};

/** Colour follows the asset class, never its size: the server's fixed order
 *  hands out the palette, and "Unclassified" is the neutral grey so it can
 *  never be mistaken for a class. */
export function useClassColors(order: { key: string }[]) {
  const dark = useIsDarkMode();
  return useMemo(() => {
    const out: Record<string, string> = {};
    let slot = 0;
    for (const c of order) {
      out[c.key] = c.key === "unclassified" ? neutral(dark) : slotColor(slot++, dark);
    }
    return out;
  }, [order, dark]);
}

/** Donut by asset class with the w-36 legend (IncomePage pattern). */
export function AssetClassDonut({
  slices, total, colors,
}: {
  slices: { key: string; label: string; value: number }[];
  total: number;
  colors: Record<string, string>;
}) {
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0 relative">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={slices} dataKey="value" nameKey="label" cx="50%" cy="50%"
              innerRadius={55} outerRadius={95} paddingAngle={2} isAnimationActive={false}>
              {slices.map((s) => (
                <Cell key={s.key} fill={colors[s.key]} stroke="transparent"
                  opacity={active === null || active === s.key ? 1 : 0.3} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number) => formatCurrency(value)} contentStyle={tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <p className="text-sm font-bold text-foreground">{formatCurrency(total)}</p>
            <p className="text-[10px] text-muted-foreground">Total</p>
          </div>
        </div>
      </div>
      <div className="w-36 shrink-0 space-y-1.5 py-1">
        {slices.map((s) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0;
          return (
            <button key={s.key} type="button"
              onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}
              className="w-full text-left rounded-md px-2 py-1 hover:bg-muted/50">
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: colors[s.key] }} />
                <span className="text-xs font-medium truncate">{s.label}</span>
              </div>
              <div className="pl-3.5 text-xs text-muted-foreground">{formatCurrency(s.value)} · {pct.toFixed(0)}%</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

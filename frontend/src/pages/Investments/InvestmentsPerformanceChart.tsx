import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { DateRange } from "@/components/ui/DateRangePicker";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { useAccountValueHistory, useInvestmentsOverview, type OverviewCard } from "@/hooks/useInvestmentsOverview";
import { neutral, slotColor } from "@/lib/chartPalette";
import { niceMoneyAxis } from "@/lib/chartTicks";
import { formatAxisDate, formatDate, spanInDays } from "@/lib/dates";
import { cn, formatCurrency } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

/**
 * Investments over time, as a total or split by type or by tax treatment:
 * the Performance card on Investments → Overview, and the "Investments by
 * Type" dashboard widget. Each account's own value series, summed.
 */

/** Type order; each type's colour is its slot in this order, never its size. */
const TYPE_ORDER = ["investing", "retirement", "education", "health"];
const TAX_ORDER = ["tax_deferred", "tax_free", "taxable", "not_set"];

const tooltipStyle = {
  background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.97,
};

type TrendView = "total" | "type" | "tax";

/** The chart's points for a range, one key per band, and the change in value
 *  over the range (summed per account, so it does not depend on the view). */
export function useInvestmentsTypeSeries(dateRange: DateRange | null, accountId: number | undefined, view: TrendView) {
  const { data } = useInvestmentsOverview();
  const { data: history } = useAccountValueHistory(dateRange);
  return useMemo(() => {
    const cards: OverviewCard[] = (data?.groups ?? []).flatMap((g) =>
      g.accounts.map((c) => ({ ...c, purpose: c.purpose ?? g.purpose })));
    const typeOf = new Map(cards.filter((c) => c.id != null).map((c) => [c.id!, c]));
    const keyFor = (c: OverviewCard) =>
      view === "total" ? "total" : view === "type" ? (c.purpose ?? "investing") : (c.tax_treatment ?? "not_set");
    const byDate = new Map<string, Record<string, number>>();
    const firstLast = new Map<number, { first: number; last: number }>();
    for (const [idStr, pts] of Object.entries(history?.series ?? {})) {
      const id = Number(idStr);
      const card = typeOf.get(id);
      // Excluded from net worth still counts here, as everywhere on Investments.
      if (!card || card.kind !== "account" || (accountId && id !== accountId)) continue;
      const key = keyFor(card);
      for (const p of pts) {
        const row = byDate.get(p.date) ?? {};
        row[key] = (row[key] ?? 0) + p.balance;
        byDate.set(p.date, row);
      }
      if (pts.length) firstLast.set(id, { first: pts[0].balance, last: pts[pts.length - 1].balance });
    }
    const points = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }));
    const order = view === "type" ? TYPE_ORDER : view === "tax" ? TAX_ORDER : ["total"];
    const keys = order.filter((k) => points.some((p) => (p as unknown as Record<string, number>)[k]));
    const delta = [...firstLast.values()].reduce((s, v) => s + (v.last - v.first), 0);
    return { points, keys, change: firstLast.size ? delta : null };
  }, [data, history, view, accountId]);
}

export function InvestmentsPerformanceChart({ dateRange, accountId, title, height = 220 }: {
  dateRange: DateRange | null;
  accountId?: number;
  /** Shown left of the view toggle; a dashboard card has its own title. */
  title?: string;
  height?: number;
}) {
  const dark = useIsDarkMode();
  const { data } = useInvestmentsOverview();
  const [view, setView] = useState<TrendView>("type");
  // Series the user switched off by clicking their legend label.
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const toggleSeries = (k: string) =>
    setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const { points, keys } = useInvestmentsTypeSeries(dateRange, accountId, view);

  // Bands stack only when more than one is on; a lone line gets a fitted axis.
  const shownKeys = keys.filter((k) => !hidden.has(k));
  const stacked = shownKeys.length > 1;
  // Stacked bands read from $0 against their summed height; a lone line is
  // fitted to its own range. Either way the ticks are round.
  const yAxis = niceMoneyAxis(
    points.map((p) => shownKeys.reduce((sum, k) => sum + ((p as unknown as Record<string, number>)[k] ?? 0), 0)),
    { fromZero: stacked },
  );
  const span = spanInDays(points[0]?.date, points[points.length - 1]?.date);
  const label = (k: string) =>
    view === "total" ? "Total"
      : view === "type" ? (data?.groups.find((g) => g.purpose === k)?.label ?? k)
        : (data?.tax_labels[k] ?? k);
  const color = (k: string, i: number) => (k === "not_set" ? neutral(dark) : slotColor(i, dark));

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className={cn("flex items-center gap-2 mb-3", title ? "justify-between" : "justify-end")}>
        {title && <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>}
        <SegmentedToggle
          value={view}
          onChange={(v) => { setView(v); setHidden(new Set()); }}
          options={[
            { value: "type", label: "By type" },
            { value: "tax", label: "By tax" },
            { value: "total", label: "Total" },
          ]}
        />
      </div>
      {points.length < 2 ? (
        <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
          No history for this range yet.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => formatAxisDate(d, span)} minTickGap={40} />
            {/* One line is fitted to its data rather than drawn from $0: a 2%
                move on a $1M line was flat against the floor of the chart.
                Two or more are stacked bands, which only read from $0. */}
            <YAxis tickFormatter={yAxis?.tickFormatter} ticks={yAxis?.ticks} tick={{ fontSize: 10 }} width={48}
              domain={yAxis?.domain ?? [0, "auto"]} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(d) => formatDate(d as string)}
              formatter={(v: number, name: string) => [formatCurrency(v), label(name)]} />
            {keys.length > 1 && (
              <Legend
                onClick={(e) => toggleSeries(String((e as { dataKey?: unknown }).dataKey))}
                wrapperStyle={{ cursor: "pointer" }}
                formatter={(v) => (
                  <span className={cn("text-xs", hidden.has(v) ? "text-muted-foreground line-through" : "text-foreground")}
                    title={hidden.has(v) ? "Show" : "Hide"}>
                    {label(v)}
                  </span>
                )}
              />
            )}
            {keys.map((k, i) => (
              <Area key={k} type="monotone" dataKey={k} name={k} stackId={stacked ? "1" : undefined}
                baseValue={stacked ? undefined : "dataMin"} hide={hidden.has(k)}
                stroke={color(k, i)} fill={color(k, i)} fillOpacity={0.25} strokeWidth={2}
                isAnimationActive={false} />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

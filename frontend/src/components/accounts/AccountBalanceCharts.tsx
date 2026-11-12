// dashboard-catalog: not offered, one account's balance, shown on that account's card and drawer.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "@/lib/api";
import { evenTicks, niceMoneyAxis } from "@/lib/chartTicks";
import { formatAxisDate, formatDate, spanInDays } from "@/lib/dates";
import { formatCurrency } from "@/lib/utils";
import { DateRangePicker, defaultRange, type DateRange } from "@/components/ui/DateRangePicker";
import { useDragZoom } from "@/hooks/useDragZoom";

export interface BalancePoint {
  date: string;
  /** A debt is the amount owed, as a positive number. */
  balance: number;
}

interface BalanceHistory {
  series: Record<string, BalancePoint[]>;
}

/** Every account's balance over the last three months, in one request: the
 *  sparklines on the cards. */
export function useAccountSparklines() {
  return useQuery<BalanceHistory>({
    queryKey: ["accounts", "balance-history", 90],
    queryFn: () => api.get<BalanceHistory>("/accounts/balance-history?days=90"),
    staleTime: 5 * 60_000,
  });
}

/** The last three months of a balance, drawn faintly across the card above
 *  the figure. It shows the shape and no more: no axis, no tooltip. An
 *  account whose balance did not move, or that has no history yet, gets a
 *  level line, so every card carries the same row. */
export function BalanceSparkline({ points, owed }: { points: BalancePoint[] | undefined; owed: boolean }) {
  const W = 200;
  const H = 22;
  const PAD = 2;
  const values = (points ?? []).map((p) => p.balance);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const moved = values.length >= 2 && max - min >= 0.5;
  const change = moved ? values[values.length - 1] - values[0] : 0;
  // More in an account is good news and more owed is not.
  const good = owed ? change < 0 : change > 0;
  const color = Math.abs(change) < 0.5 ? "hsl(var(--muted-foreground))" : good ? "hsl(var(--success))" : "hsl(var(--destructive))";
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - min) / (max - min)) * (H - 2 * PAD);
  const line = moved
    ? values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
    : `M${PAD},${H / 2} L${W - PAD},${H / 2}`;
  const summary = !moved
    ? "no change"
    : `${change > 0 ? "+" : "−"}${formatCurrency(Math.abs(change))}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${owed ? "Balance owed" : "Balance"} over the last three months: ${summary}`}
      className="block h-[22px] w-full"
    >
      <title>{`Last 3 months: ${summary}`}</title>
      <path
        d={line} fill="none" stroke={color} strokeOpacity={moved ? 0.45 : 0.25}
        strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** One account's balance over time, in its drawer, over any range the
 *  standard picker offers. */
export function AccountBalanceChart({ accountId, owed, currency, title }: {
  accountId: number; owed: boolean; currency: string;
  /** Overrides "Balance over time" (an investment plan's drawer: "Performance"). */
  title?: string;
}) {
  const [range, setRange] = useState<DateRange | null>(defaultRange);
  // Drag across the chart to zoom into those dates.
  const zoom = useDragZoom({ range, setRange });
  // "All time" asks for the longest span the server charts.
  const query = range ? `date_from=${range.from}&date_to=${range.to}` : "days=3650";
  const { data, isLoading } = useQuery<BalanceHistory>({
    queryKey: ["accounts", "balance-history", accountId, range?.from ?? "all", range?.to ?? "all"],
    queryFn: () => api.get<BalanceHistory>(`/accounts/balance-history?account_id=${accountId}&${query}`),
    staleTime: 5 * 60_000,
  });
  const points = data?.series[String(accountId)] ?? [];
  const first = points[0];
  const last = points[points.length - 1];
  const change = first && last ? last.balance - first.balance : 0;
  const flat = Math.abs(change) < 0.5;
  const good = owed ? change < 0 : change > 0;
  const color = flat ? "hsl(var(--muted-foreground))" : good ? "hsl(var(--success))" : "hsl(var(--destructive))";
  const span = spanInDays(first?.date, last?.date);
  const yAxis = niceMoneyAxis(points.map((p) => p.balance));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {title ?? (owed ? "Balance owed over time" : "Balance over time")}
          </p>
          {points.length > 1 && (
            <p className="text-xs tabular-nums" style={{ color }}>
              {flat ? "No change" : `${change > 0 ? "+" : "−"}${formatCurrency(Math.abs(change), currency)}`}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {zoom.resetButton}
          <DateRangePicker value={range} onChange={setRange} onClearAll={() => setRange(null)} />
        </div>
      </div>
      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : points.length < 2 ? (
        <p className="flex h-40 items-center justify-center text-center text-sm text-muted-foreground">
          No balance history for this account yet.
        </p>
      ) : (
        <div {...zoom.wrapperProps}>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={points} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} {...zoom.chartProps}>
            <defs>
              <linearGradient id={`acctBal${accountId}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => formatAxisDate(d, span)} ticks={evenTicks(points, "date", 4)} interval={0} />
            <YAxis tickFormatter={yAxis?.tickFormatter} ticks={yAxis?.ticks} domain={yAxis?.domain ?? ["auto", "auto"]} tick={{ fontSize: 10 }} width={48} />
            <Tooltip
              formatter={(v: number) => [formatCurrency(v, currency), owed ? "Owed" : "Balance"]}
              labelFormatter={(d) => formatDate(String(d))}
              contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
            />
            {zoom.area}
            <Area type="monotone" dataKey="balance" stroke={color} strokeWidth={2} fill={`url(#acctBal${accountId})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

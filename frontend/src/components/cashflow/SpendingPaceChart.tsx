import { useMemo } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { moneyAxisFor } from "@/lib/chartTicks";
import { neutral, slotColor } from "@/lib/chartPalette";
import { cn, formatCurrency } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

interface SpendingPace {
  /** "YYYY-MM". */
  month: string;
  previous_month: string;
  days_in_month: number;
  /** The last day `current` reaches: today, or the month's last day. */
  through_day: number;
  /** Spending so far in the month at the end of each day. */
  current: { day: number; total: number }[];
  previous: { day: number; total: number }[];
  total: number;
  /** What the month before had spent by the same day of the month. */
  previous_to_date: number;
  previous_total: number;
}

/** Spending so far this month, day by day, beside last month. */
export function useSpendingPace() {
  return useQuery<SpendingPace>({
    queryKey: ["dashboard", "spending-pace"],
    queryFn: () => api.get<SpendingPace>("/dashboard/spending-pace"),
    staleTime: 5 * 60_000,
  });
}

function monthName(ym: string, style: "long" | "short" = "long"): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: style });
}

type Row = { day: number; current?: number; previous?: number; budget?: number };

/**
 * How this month's spending is running against last month's: both
 * months as a running total by day of the month, this month drawn up to
 * today over the whole month's axis, so how far into the month it is reads
 * at a glance. The headline compares like with like, the same day of each.
 *
 * Spending is what Cash Flow counts as expenses: money out, settled, and not
 * a transfer such as a card payment.
 */
export function SpendingPaceChart({ data, height = 200, budget }: {
  data: SpendingPace;
  height?: number;
  /** The month's budget total, drawn as a dashed line to spend against. */
  budget?: number;
}) {
  const dark = useIsDarkMode();
  const thisColor = slotColor(0, dark);
  const lastColor = neutral(dark);
  const thisName = monthName(data.month);
  const lastName = monthName(data.previous_month);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (let day = 1; day <= Math.max(data.days_in_month, data.previous.length); day++) {
      out.push({
        day,
        current: data.current[day - 1]?.total,
        previous: data.previous[day - 1]?.total,
        budget: budget && budget > 0 && day <= data.days_in_month ? budget : undefined,
      });
    }
    return out;
  }, [data, budget]);
  const yAxis = moneyAxisFor(rows, ["current", "previous", "budget"], { fromZero: true });

  const diff = data.total - data.previous_to_date;
  const same = Math.abs(diff) < 0.5;
  const finished = data.through_day === data.days_in_month;

  const renderTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload as Row;
    return (
      <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-md">
        <p className="text-muted-foreground mb-1">Day {label}</p>
        {[
          { name: thisName, value: row.current, color: thisColor },
          { name: lastName, value: row.previous, color: lastColor },
        ].filter((s) => s.value != null).map((s) => (
          <p key={s.name} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name}
            </span>
            <span className="font-medium">{formatCurrency(s.value!)}</span>
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xl font-bold tabular-nums">{formatCurrency(data.total)}</p>
        <p className="text-xs text-muted-foreground">
          {finished ? `spent in ${thisName}` : "spent so far this month"}
          {" · "}
          {same ? (
            <>about the same as {lastName} by this day</>
          ) : (
            <span className={cn("font-medium", diff < 0 ? "text-success" : "text-destructive")}>
              {formatCurrency(Math.abs(diff))} {diff < 0 ? "less" : "more"} than {lastName} by day {data.through_day}
            </span>
          )}
        </p>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="spending-pace-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={thisColor} stopOpacity={0.25} />
              <stop offset="100%" stopColor={thisColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
          <XAxis dataKey="day" type="number" domain={[1, data.days_in_month]} ticks={[1, 8, 15, 22, data.days_in_month]}
            tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
          <YAxis tickFormatter={yAxis.tickFormatter} ticks={yAxis.ticks} domain={yAxis.domain}
            tick={{ fontSize: 10 }} width={48} stroke="hsl(var(--muted-foreground))" />
          <Tooltip content={renderTooltip} />
          <Line type="monotone" dataKey="previous" name={lastName} stroke={lastColor} strokeWidth={1.5}
            strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} />
          {budget != null && budget > 0 && (
            <Line type="linear" dataKey="budget" name="Budget" stroke="hsl(var(--foreground))" strokeOpacity={0.5}
              strokeWidth={1} strokeDasharray="2 3" dot={false} isAnimationActive={false} />
          )}
          <Area type="monotone" dataKey="current" name={thisName} stroke={thisColor} strokeWidth={2}
            fill="url(#spending-pace-fill)" dot={false} isAnimationActive={false} connectNulls={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex items-center justify-center gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded" style={{ background: thisColor }} />
          {thisName}
        </span>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: lastColor }} />
          {lastName}: {formatCurrency(data.previous_total)}
        </span>
        {budget != null && budget > 0 && (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="h-0 w-4 border-t border-dotted border-foreground/60" />
            Budget: {formatCurrency(budget)}
          </span>
        )}
      </div>
    </div>
  );
}

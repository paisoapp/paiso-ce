// dashboard-catalog: not offered, one budget category inside its own side drawer
import { useMemo, useState } from "react";
import {
  Bar, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { CHART_VIEW_ICONS } from "@/components/ui/ChartViewIcons";
import { usePersistedState } from "@/hooks/usePersistedState";
import { DateRangePicker, type DateRange } from "@/components/ui/DateRangePicker";
import { TransactionTable } from "@/pages/Transactions/TransactionTable";
import { useCategoryDetail, useCategoryReport, type ProgressLine } from "@/hooks/useBudgetPlan";
import { moneyAxisFor } from "@/lib/chartTicks";
import { formatCurrency } from "@/lib/utils";

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Six months ending with the month on screen (today, for this month). */
function defaultRange(month: string): DateRange {
  const [y, m] = month.split("-").map(Number);
  const today = new Date();
  const end = y === today.getFullYear() && m === today.getMonth() + 1 ? today : new Date(y, m, 0);
  return { from: iso(new Date(y, m - 6, 1)), to: iso(end) };
}

/** When the amount in effect for `month` was set: "this month only", or
 *  "since Mar 2026" when it was set in an earlier month. */
function amountSince(amounts: { month: string; scope: "onward" | "month" }[], month: string, oneMonth: boolean): string | undefined {
  if (oneMonth) return "this month only";
  const from = amounts.filter((a) => a.scope === "onward" && a.month <= month).map((a) => a.month).sort().pop();
  return from && from < month ? `since ${monthText(from)}` : undefined;
}

function monthText(month: string): string {
  return new Date(month + "-15").toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const CARD = "rounded-xl border border-border bg-card p-4";

/** One chart with a toggle, as on the Cash Flow page. */
const CHART_TYPES = [
  { value: "bars", label: "Bars", icon: CHART_VIEW_ICONS.bars },
  { value: "trend", label: "Trend", icon: CHART_VIEW_ICONS.trend },
] satisfies { value: string; label: string; icon: unknown }[];
type ChartType = (typeof CHART_TYPES)[number]["value"];

/** Titles for each view. Under three months the report is weekly:
 *  bars per week, and a day-by-day running total against the allocation. */
const TITLES: Record<"month" | "week", Record<ChartType, string>> = {
  month: { bars: "Used against allocated", trend: "Trend" },
  week: { bars: "Used each week", trend: "Running total against allocated" },
};

function dayText(isoDate: string): string {
  return new Date(isoDate + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
const CARD_TITLE = "text-sm font-medium text-muted-foreground mb-2";

/**
 * A budget category up close: spending month by month against
 * what was allocated, its trend, the figures for the month on screen, which
 * months used which amount, the rollover month by month, and the transactions.
 * A transaction opens in its own drawer on top of this one, to edit it here.
 */
export function CategoryDrawer({ line, month, onClose }: { line: ProgressLine | null; month: string; onClose: () => void }) {
  return (
    <SideDrawer open={line != null} onClose={onClose} title={line?.name}>
      {line && <DrawerBody key={`${line.category_id}-${month}`} line={line} month={month} />}
    </SideDrawer>
  );
}

function DrawerBody({ line, month }: { line: ProgressLine; month: string }) {
  const [range, setRange] = useState<DateRange>(() => defaultRange(month));
  const [chartType, setChartType] = usePersistedState<ChartType>(
    "paiso.budget.categoryChart", "bars", CHART_TYPES.map((c) => c.value),
  );
  const { data: report } = useCategoryReport(line.category_id, range.from, range.to);
  const { data: detail } = useCategoryDetail(line.category_id, month);

  const rows = useMemo(
    () =>
      (report?.months ?? []).map((r, i, all) => {
        // Three-month average, for the trend line.
        const window = all.slice(Math.max(0, i - 2), i + 1);
        return { ...r, short: r.label.slice(0, 3), avg3: Math.round(window.reduce((s, w) => s + w.spent, 0) / window.length) };
      }),
    [report],
  );
  const granularity = report?.granularity ?? "month";
  const weekly = granularity === "week";
  const weekRows = useMemo(
    () => (report?.weeks ?? []).map((w) => ({ ...w, short: w.label, label: `Week of ${w.label}` })),
    [report],
  );
  const dayRows = useMemo(
    () => (report?.days ?? []).map((d) => ({ ...d, short: dayText(d.date), label: dayText(d.date) })),
    [report],
  );
  const barRows = weekly ? weekRows : rows;
  const monthTotals = useMemo(
    () => Object.fromEntries((report?.months ?? []).map((r) => [r.month, r.spent])),
    [report],
  );
  const barAxis = moneyAxisFor(barRows, ["spent", "allocated"], { fromZero: true });
  const lineAxis = weekly
    ? moneyAxisFor(dayRows, ["cumulative", "allocated"], { fromZero: true })
    : moneyAxisFor(rows, ["spent", "avg3"], { fromZero: true });
  const tooltip = (v: unknown, name: string) => [typeof v === "number" ? formatCurrency(v) : "None", name];

  return (
    <div className="px-5 py-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{report?.on_budget === false ? "Not on this budget" : weekly ? "Week by week" : "Month by month"}</p>
        <DateRangePicker value={range} onChange={(r) => r && setRange(r)} />
      </div>

      <div className={CARD}>
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {TITLES[granularity][chartType]}
          </h3>
          <SegmentedToggle value={chartType} onChange={setChartType} options={CHART_TYPES} />
        </div>
        <div className="h-52">
          <ResponsiveContainer width="100%" height="100%">
            {chartType === "bars" ? (
              <ComposedChart data={barRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="short" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                <YAxis width={48} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} {...barAxis} />
                <Tooltip formatter={tooltip} labelFormatter={(_l, p) => p?.[0]?.payload?.label ?? ""} contentStyle={{ fontSize: 12 }} />
                <Bar dataKey="spent" name="Used" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                <Line dataKey="allocated" name={weekly ? "Allocated for the week" : "Allocated"} type="stepAfter"
                  stroke="hsl(var(--foreground))" strokeDasharray="4 3" strokeOpacity={0.6} dot={allocatedMark} connectNulls={false}
                  // Dots are drawn when the line's animation ends, which a
                  // one-point line never does.
                  isAnimationActive={false} />
              </ComposedChart>
            ) : weekly ? (
              <LineChart data={dayRows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="short" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} minTickGap={24} />
                <YAxis width={48} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} {...lineAxis} />
                <Tooltip formatter={tooltip} labelFormatter={(_l, p) => p?.[0]?.payload?.label ?? ""} contentStyle={{ fontSize: 12 }} />
                <Line dataKey="cumulative" name="Used so far" type="stepAfter" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                <Line dataKey="allocated" name="Allocated" type="stepAfter" stroke="hsl(var(--foreground))"
                  strokeDasharray="4 3" strokeOpacity={0.6} dot={false} />
              </LineChart>
            ) : (
              <LineChart data={rows} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="short" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} />
                <YAxis width={48} tickLine={false} axisLine={false} tick={{ fontSize: 11 }} {...lineAxis} />
                <Tooltip formatter={tooltip} labelFormatter={(_l, p) => p?.[0]?.payload?.label ?? ""} contentStyle={{ fontSize: 12 }} />
                <Line dataKey="spent" name="Used" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
                <Line dataKey="avg3" name="3-month average" stroke="hsl(var(--muted-foreground))" strokeDasharray="4 3" dot={false} />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1.5 text-sm">
        {/* The "Amounts" list that sat below was each time the amount was set;
            what matters for the month is when its amount was set. */}
        <Row label={`Allocated in ${monthText(month)}`} value={formatCurrency(line.budgeted)}
          note={amountSince(report?.amounts ?? [], month, line.one_month)} />
        <Row label="Used" value={formatCurrency(line.actual)} />
        <Row
          label="Remaining"
          value={formatCurrency(line.remaining)}
          className={line.remaining < 0 ? "text-destructive" : ""}
        />
        {detail && <Row label="6-month average" value={formatCurrency(detail.average)} />}
        <Row label="Rollover" value={line.rollover_enabled
          ? `On, ${Math.round(line.carryover) > 0 ? "+" : ""}${formatCurrency(Math.round(line.carryover) || 0)} carried in`
          : "Off"} />
      </div>

      {report?.rollover_enabled && (
        <div>
          <p className={CARD_TITLE}>Rollover by month</p>
          <div className="overflow-x-auto rounded-lg border border-border" data-horizontal-scroll>
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left font-normal px-3 py-1.5">Month</th>
                  <th className="text-right font-normal px-3 py-1.5">In</th>
                  <th className="text-right font-normal px-3 py-1.5">Allocated</th>
                  <th className="text-right font-normal px-3 py-1.5">Used</th>
                  <th className="text-right font-normal px-3 py-1.5">Out</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {[...report.months].reverse().filter((r) => r.carried_out != null).map((r) => (
                  <tr key={r.month} className="border-b border-border last:border-0">
                    <td className="px-3 py-1.5">{r.label}</td>
                    <td className="px-3 py-1.5 text-right">{formatCurrency(r.carried_in ?? 0)}</td>
                    <td className="px-3 py-1.5 text-right">{formatCurrency(r.allocated ?? 0)}</td>
                    <td className="px-3 py-1.5 text-right">{formatCurrency(r.spent)}</td>
                    <td className={`px-3 py-1.5 text-right ${(r.carried_out ?? 0) < 0 ? "text-destructive" : ""}`}>
                      {formatCurrency(r.carried_out ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <TransactionTable
        key={`${line.category_id}-${range.from}-${range.to}`}
        title="Transactions"
        compact
        groupByMonth
        monthTotals={monthTotals}
        externalFilters={{
          category_id: line.category_id,
          date_from: range.from,
          date_to: range.to,
          // Pending rows are not in the Used figure, so they are not listed either.
          exclude_pending: true,
          // Nor is a loan's side of a payment ("PRINCIPAL PAYMENT" on the mortgage).
          exclude_loan_credits: true,
        }}
      />
    </div>
  );
}

/** A short dash on each bar at its allocated amount. The step line alone
 *  draws nothing when only one month has an amount, as in a budget's first
 *  month. */
function allocatedMark(props: { cx?: number; cy?: number; index?: number; value?: number | null }) {
  const { cx, cy, index, value } = props;
  if (cx == null || cy == null || value == null) return <g key={`alloc-${index}`} />;
  return (
    <line key={`alloc-${index}`} x1={cx - 9} x2={cx + 9} y1={cy} y2={cy}
      stroke="hsl(var(--foreground))" strokeOpacity={0.75} strokeWidth={2} strokeLinecap="round" />
  );
}

function Row({ label, value, note, className = "" }: { label: string; value: string; note?: string; className?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">
        <span className={`tabular-nums font-medium ${className}`}>{value}</span>
        {note && <span className="block text-[11px] text-muted-foreground">{note}</span>}
      </span>
    </div>
  );
}

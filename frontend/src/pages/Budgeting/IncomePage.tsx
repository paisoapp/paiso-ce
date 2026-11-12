import { useState } from "react";
import { CompareLine, CompareTable } from "./compare";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DateRangePicker, type DateRange, resolveCompare } from "@/components/ui/DateRangePicker";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { RangeEmptyHint, RangeWidenedNotice } from "@/components/ui/RangeEmptyHint";
import { useAutoWidenRange, useWidenWhenEmpty } from "@/hooks/useSectionDateRange";
import { useIncome, useBudgetTrend, type BudgetParams } from "@/hooks/useBudget";
import { useAccounts } from "@/hooks/useAccounts";
import { useBudgetDateRange } from "./budgetContext";
import { assignSlots, neutral, slotColor } from "./colors";
import { useIsDarkMode } from "@/store/theme";
import { TransactionTable } from "@/pages/Transactions/TransactionTable";
import { TransfersNote } from "./TransfersNote";
import { formatCurrency } from "@/lib/utils";
import { moneyAxisFor } from "@/lib/chartTicks";


type ChartType = "bar" | "donut";

function ChartTypeToggle({ value, onChange }: { value: ChartType; onChange: (v: ChartType) => void }) {
  return (
    <div role="group" aria-label="Chart type" className="flex rounded-md overflow-hidden border border-border">
      {(["donut", "bar"] as ChartType[]).map((t) => (
        <button
          key={t}
          type="button"
          aria-pressed={value === t}
          onClick={() => onChange(t)}
          className={`px-2.5 py-1 text-xs capitalize transition-colors ${
            value === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/** Income by source, as a donut or bars. Also the "Income by Source"
 *  dashboard widget. */
export function IncomeChart({
  chartType,
  chartData,
  compareRange,
  selectedCategory,
  onSelect,
  isLoading,
  total,
}: {
  chartType: ChartType;
  chartData: { name: string; current: number; compare: number; color: string; category_id: number | null }[];
  compareRange: DateRange | null;
  selectedCategory: number | null;
  onSelect: (id: number | null) => void;
  isLoading: boolean;
  total: number;
}) {
  if (isLoading) return <div className="h-64 flex items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  if (chartData.length === 0) return <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">No income in this period.</div>;

  const pieData = chartData.map((r) => ({ ...r, value: r.current }));
  const tooltipStyle = { background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.97 };

  return (
    <div className="flex gap-4 items-start">
      <div className="flex-1 min-w-0">
        {chartType === "bar" ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 40 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-30} textAnchor="end" interval={0} />
              <YAxis {...moneyAxisFor(chartData, ["current", "compare"], { fromZero: true })} tick={{ fontSize: 11 }} />
              <Tooltip cursor={false} formatter={(value: number) => formatCurrency(value)} contentStyle={tooltipStyle} />
              <Bar dataKey="current" name="Current" radius={[4, 4, 0, 0]} onClick={(e) => onSelect(selectedCategory === e.category_id ? null : e.category_id)}>
                {chartData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} opacity={selectedCategory === null || selectedCategory === entry.category_id ? 1 : 0.4} />
                ))}
              </Bar>
              {compareRange && <Bar dataKey="compare" name="Prior" fill="#94a3b8" radius={[4, 4, 0, 0]} opacity={0.5} />}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="relative">
            <ResponsiveContainer width="100%" height={240}>
              <PieChart>
                <Pie data={pieData} cx="50%" cy="50%" innerRadius={55} outerRadius={95} paddingAngle={2} dataKey="value"
                  onClick={(e) => { const id = e.category_id as number | null; onSelect(selectedCategory === id ? null : id); }} cursor="pointer">
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} opacity={selectedCategory === null || selectedCategory === entry.category_id ? 1 : 0.3} stroke="transparent" />
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
        )}
      </div>
      <div className="w-36 shrink-0 space-y-1.5 overflow-y-auto max-h-[240px] py-1">
        {chartData.map((entry) => {
          const pct = total > 0 ? (entry.current / total) * 100 : 0;
          const active = selectedCategory === null || selectedCategory === entry.category_id;
          return (
            <button key={entry.category_id ?? "uncat"}
              onClick={() => onSelect(selectedCategory === entry.category_id ? null : entry.category_id)}
              className={`w-full text-left rounded-md px-2 py-1 transition-colors ${active ? "opacity-100" : "opacity-40"} hover:bg-muted/50`}>
              <div className="flex items-center gap-1.5 mb-0.5">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: entry.color }} />
                <span className="text-xs font-medium truncate">{entry.name}</span>
              </div>
              <div className="pl-3.5 text-xs text-muted-foreground">{formatCurrency(entry.current)} · {pct.toFixed(0)}%</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Income per period over a range. Also the "Income Over Time" widget. */
export function IncomeTrendChart({ trendParams, isLoading }: { trendParams: BudgetParams; isLoading: boolean }) {
  const { data: trend = [], isLoading: trendLoading } = useBudgetTrend(trendParams);

  if (isLoading || trendLoading) return <div className="h-64 flex items-center justify-center"><div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" /></div>;
  if (trend.length === 0) return <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">No trend data for this period.</div>;

  const tickInterval = trend.length > 15 ? Math.floor(trend.length / 8) : 0;

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={trend} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
        <defs>
          <linearGradient id="incGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={tickInterval} />
        <YAxis {...moneyAxisFor(trend, ["income"], { fromZero: true })} tick={{ fontSize: 11 }} />
        <Tooltip
          formatter={(value: number) => [formatCurrency(value), "Income"]}
          labelFormatter={(label) => String(label)}
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95 }}
        />
        <Area type="monotone" dataKey="income" stroke="#22c55e" fill="url(#incGrad)" strokeWidth={2} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** The donut's slices. Shared with the Sankey and the Expenses donut — see
 *  colors.ts. Income sources (salary, dividends, interest, ...) each land on
 *  their own hue, and keep it as the amounts move around them. */
export function incomeChartData(
  rows: { category_id: number | null; category_name: string; total: number }[],
  compareRows: { category_id: number | null; total: number }[] | undefined,
  dark: boolean,
) {
  const visible = rows.filter((r) => r.total > 0);
  const slots = assignSlots(visible.map((r) => r.category_id));
  return visible.map((r) => ({
    name: r.category_name,
    current: r.total,
    compare: compareRows?.find((c) => c.category_id === r.category_id)?.total ?? 0,
    color: r.category_id == null || slots.get(r.category_id) == null
      ? neutral(dark)
      : slotColor(slots.get(r.category_id) as number, dark),
    category_id: r.category_id,
  }));
}

export function IncomePage() {
  // The palette has its own steps per surface; dark is chosen, not inverted.
  const dark = useIsDarkMode();
  const { dateRange, setDateRange, compare, setCompare } = useBudgetDateRange();
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  // What the page shows: the section's range, or a wider one when that is empty.
  const widen = useAutoWidenRange("budgeting", dateRange, `income:${accountId ?? "all"}`);
  const range = widen.range;
  // Against the range on screen, so a widened range is compared like for like.
  const compareRange = resolveCompare(compare, range);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [chartType, setChartType] = useState<ChartType>("donut");

  const { data: allAccounts = [] } = useAccounts();

  const params: BudgetParams = {
    date_from: range?.from,
    date_to: range?.to,
    compare_from: compareRange?.from,
    compare_to: compareRange?.to,
    account_id: accountId,
  };

  const { data, isLoading } = useIncome(params);

  const rows = data?.by_category ?? [];
  const chartData = incomeChartData(rows, data?.compare?.by_category, dark);

  const total = data?.total ?? 0;
  const isEmpty = total === 0;
  useWidenWhenEmpty(widen, { isLoading, isEmpty });

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Income</h2>
          {!isLoading && (
            <p className="text-sm text-muted-foreground">
              Total:{" "}
              <span className="font-medium text-success">
                {formatCurrency(total)}
              </span>
              {data?.compare && (
                <CompareLine className="ml-2" now={total} before={data.compare.total} direction="up-is-good" />
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            value={range}
            onChange={setDateRange}
            onClearAll={() => setDateRange(null)}
            compare={compare}
            onCompareChange={setCompare}
          />
          {allAccounts.length > 1 && (
            <AccountFilterSelect
              value={accountId}
              onChange={(id) => { setAccountId(id); setSelectedCategory(null); }}
              accounts={allAccounts.map((a) => ({ id: a.id, name: a.display_name }))}
            />
          )}
        </div>
      </div>

      <RangeWidenedNotice widen={widen} />
      <RangeEmptyHint show={!isLoading && isEmpty && !widen.widenedFrom} range={range} onPick={setDateRange} />

      {/* ── Charts ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-muted-foreground">By Source</h3>
            <ChartTypeToggle value={chartType} onChange={setChartType} />
          </div>
          <IncomeChart
            chartType={chartType} chartData={chartData} compareRange={compareRange}
            selectedCategory={selectedCategory} onSelect={setSelectedCategory}
            isLoading={isLoading} total={total}
          />
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Income Trend</h3>
          <IncomeTrendChart trendParams={{ date_from: range?.from, date_to: range?.to, account_id: accountId }} isLoading={isLoading} />
        </div>
      </div>

      {/* ── Compare table ──────────────────────────────────────────────────── */}
      {compareRange && data?.compare && (
        <CompareTable
          heading="Source"
          current={rows}
          prior={data.compare.by_category}
          currentRange={range}
          priorRange={compareRange}
          direction="up-is-good"
          colorOf={(id) => chartData.find((c) => c.category_id === id)?.color ?? neutral(dark)}
        />
      )}

      {/* ── Transaction table ──────────────────────────────────────────────── */}
      <div>
        <h3 className="text-base font-semibold mb-3">
          Income Transactions
          {selectedCategory !== null && (
            <button className="ml-2 text-xs text-primary underline font-normal" onClick={() => setSelectedCategory(null)}>Clear filter</button>
          )}
        </h3>
        <TransactionTable
          key={`inc-${range?.from ?? "all"}-${range?.to ?? "all"}-${accountId ?? "all"}-${selectedCategory ?? "all"}`}
          externalFilters={{
            date_from: range?.from,
            date_to: range?.to,
            account_id: accountId,
            // Refunds and a loan's side of a payment are not income, as the
            // total above counts it.
            amount_sign: "income",
            exclude_loan_credits: true,
            exclude_transfers: true,
            // Budgeting pages are about totals, so their embedded list must
            // agree with the headline figure — unsettled rows are excluded from
            // both. The full ledger, including pending, lives on /transactions.
            exclude_pending: true,
            category_id: selectedCategory ?? undefined,
          }}
        />
      </div>

      {/* ── Reconciliation note → Transfers tab ─────────────────────────────── */}
      <TransfersNote
        dateFrom={range?.from}
        dateTo={range?.to}
        accountId={accountId}
        noun="income"
      />
    </div>
  );
}

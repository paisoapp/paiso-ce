// dashboard-catalog: not offered, its figures are on the dashboard as Income vs Expenses and Money Flow.
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DateRangePicker, resolveCompare } from "@/components/ui/DateRangePicker";
import { CompareLine } from "./compare";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { FeatureTip } from "@/components/onboarding/FeatureTip";
import { RangeEmptyHint, RangeWidenedNotice } from "@/components/ui/RangeEmptyHint";
import { useAutoWidenRange, useWidenWhenEmpty } from "@/hooks/useSectionDateRange";
import { bucketCashFlow, useCashFlow, useIncome, useExpenses } from "@/hooks/useBudget";
import { EXPENSE_COLOR, INCOME_COLOR } from "@/lib/chartPalette";
import { useAccounts } from "@/hooks/useAccounts";
import { TransactionTable } from "@/pages/Transactions/TransactionTable";
import { formatCurrency } from "@/lib/utils";
import { useBudgetDateRange } from "./budgetContext";
import { CashFlowSankey, type SelectedCategory } from "./CashFlowSankey";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { CHART_VIEW_ICONS } from "@/components/ui/ChartViewIcons";
import { usePersistedState } from "@/hooks/usePersistedState";
import { formatDate, formatShortDate } from "@/lib/dates";
import { moneyAxisFor } from "@/lib/chartTicks";

type ChartType = "sankey" | "bar" | "area";
// The app-wide order for chart views: Trend, Bars, Sankey. The page
// still opens on Sankey.
const CHART_TYPES = [
  { value: "area", label: "Trend", title: "Daily Cash Flow", icon: CHART_VIEW_ICONS.trend },
  { value: "bar", label: "Bars", title: "Income & Expenses", icon: CHART_VIEW_ICONS.bars },
  { value: "sankey", label: "Sankey", title: "Money Flow", icon: CHART_VIEW_ICONS.sankey },
] satisfies { value: ChartType; label: string; title: string; icon: unknown }[];

const shortDate = (iso: string) => formatShortDate(iso);
const fullDate = (iso: string) => formatDate(iso);

export function CashFlowPage() {
  const { dateRange, setDateRange, compare, setCompare } = useBudgetDateRange();
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  // What the page shows: the section's range, or a wider one when that is empty.
  const widen = useAutoWidenRange("budgeting", dateRange, `cashflow:${accountId ?? "all"}`);
  const range = widen.range;
  // Against the range on screen, so a widened range is compared like for like.
  const compareRange = resolveCompare(compare, range);
  // Sankey first: it answers "where did the money go" at a glance, which is
  // what the page is opened for. The key carries a version because the old one
  // was written on every visit, so it holds "area" for everyone who ever
  // opened this page, whether or not they chose it.
  const [chartType, setChartTypeRaw] = usePersistedState<ChartType>(
    "paiso.cashflow.chartType.v2", "sankey", CHART_TYPES.map((t) => t.value),
  );
  // Category picked by clicking a Sankey node; filters the transaction table below.
  const [selectedCategory, setSelectedCategory] = useState<SelectedCategory | null>(null);
  const setChartType = (v: ChartType) => {
    if (v !== "sankey") setSelectedCategory(null); // selection only makes sense on the Sankey
    setChartTypeRaw(v);
  };
  const selectCategory = (c: SelectedCategory) =>
    setSelectedCategory((prev) => (prev?.id === c.id ? null : c));
  // Series the user has toggled off via the legend. Net starts hidden so the
  // chart opens on its income/expense components, not the summary line.
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set(["net"]));
  const toggleSeries = (key: string) =>
    setHiddenSeries((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const { data: allAccounts = [] } = useAccounts();

  const params = {
    date_from: range?.from,
    date_to: range?.to,
    compare_from: compareRange?.from,
    compare_to: compareRange?.to,
    account_id: accountId,
  };

  const { data, isLoading } = useCashFlow(params);

  // Category breakdowns power the Sankey view; only fetched when it's active.
  const sankeyActive = chartType === "sankey";
  const sankeyParams = {
    date_from: range?.from,
    date_to: range?.to,
    compare_from: compareRange?.from,
    compare_to: compareRange?.to,
    account_id: accountId,
  };
  const { data: incomeData, isLoading: incomeLoading } = useIncome(sankeyParams, { enabled: sankeyActive });
  const { data: expensesData, isLoading: expensesLoading } = useExpenses(sankeyParams, { enabled: sankeyActive });
  const sankeyLoading = isLoading || incomeLoading || expensesLoading;

  const chartData = (data?.series ?? []).map((day, i) => {
    const cmp = data?.compare_series?.[i];
    return {
      date: day.date,        // ISO date — used for tooltip labelFormatter
      displayDate: shortDate(day.date),  // MM/DD — shown on X-axis ticks
      income: Math.abs(day.income),
      expenses: -Math.abs(day.expenses),
      net: day.net,
      cmp_net: cmp?.net,
    };
  });

  // Bars: income above the axis, expenses below, a bar per day, week or month
  // depending on how long the range is.
  const barData = bucketCashFlow(data?.series ?? [], range?.from, range?.to).map((b) => ({
    label: b.label,
    income: b.income,
    expenses: -b.expenses,
  }));

  const totalIncome = data?.series.reduce((s, d) => s + d.income, 0) ?? 0;
  const totalExpenses = Math.abs(data?.series.reduce((s, d) => s + d.expenses, 0) ?? 0);
  const netFlow = totalIncome - totalExpenses;
  const isEmpty = totalIncome === 0 && totalExpenses === 0;
  // Totals for the comparison period — the whole of it, not only the days the
  // chart has room to overlay.
  const prior = data?.compare_series
    ? {
        income: data.compare_series.reduce((s, d) => s + d.income, 0),
        expenses: Math.abs(data.compare_series.reduce((s, d) => s + d.expenses, 0)),
      }
    : null;
  useWidenWhenEmpty(widen, { isLoading, isEmpty });

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            Cash Flow
            <FeatureTip
              id="cashflow-compare"
              title="Compare with past months"
              enabled={!isLoading}
              placement="bottom"
            >
              Use the <span className="font-medium">Compare</span> option in the date
              picker to overlay a previous period and see how this month stacks up.
            </FeatureTip>
          </h2>
          {!isLoading && (
            <p className="text-sm text-muted-foreground">
              Net:{" "}
              <span className={`font-medium ${netFlow >= 0 ? "text-success" : "text-destructive"}`}>
                {netFlow >= 0 ? "+" : "\u2212"}{formatCurrency(Math.abs(netFlow))}
              </span>
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

      {/* An empty range is swapped for a wider one, and says so. One the user
          picked by hand stays put and offers the wider range instead. */}
      <RangeWidenedNotice widen={widen} />
      <RangeEmptyHint show={!isLoading && isEmpty && !widen.widenedFrom} range={range} onPick={setDateRange} />

      {/* ── Summary cards ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Income", value: totalIncome, positive: true,
            now: totalIncome, before: prior?.income, direction: "up-is-good" as const },
          { label: "Expenses", value: totalExpenses, positive: false,
            now: totalExpenses, before: prior?.expenses, direction: "up-is-bad" as const },
          // Net is compared signed: a swing from -$200 to +$300 is +$500.
          { label: "Net Flow", value: Math.abs(netFlow), positive: netFlow >= 0,
            now: netFlow, before: prior ? prior.income - prior.expenses : undefined, direction: "up-is-good" as const },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            {isLoading ? (
              <div className="h-6 w-24 rounded bg-muted animate-pulse mt-1" />
            ) : (
              <p className={`text-lg font-semibold ${card.positive ? "text-success" : "text-destructive"}`}>
                {formatCurrency(card.value)}
              </p>
            )}
            {!isLoading && card.before != null && (
              <CompareLine className="block mt-0.5" now={card.now} before={card.before} direction={card.direction} />
            )}
          </div>
        ))}
      </div>

      {/* ── Chart ──────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-2 mb-3">
          <h3 className="text-sm font-medium text-muted-foreground">
            {CHART_TYPES.find((t) => t.value === chartType)?.title}
          </h3>
          <SegmentedToggle
            value={chartType}
            onChange={setChartType}
            options={CHART_TYPES}
          />
        </div>
        {chartType === "sankey" ? (
          <>
            {selectedCategory && (
              <p className="text-xs text-muted-foreground mb-2">
                Filtered to <span className="font-medium text-foreground">{selectedCategory.name}</span>
                <button className="ml-2 text-primary underline" onClick={() => setSelectedCategory(null)}>Clear</button>
              </p>
            )}
            <CashFlowSankey
              incomeRows={incomeData?.by_category ?? []}
              expenseRows={expensesData?.by_category ?? []}
              priorIncomeRows={compareRange ? incomeData?.compare?.by_category : undefined}
              priorExpenseRows={compareRange ? expensesData?.compare?.by_category : undefined}
              isLoading={sankeyLoading}
              selectedId={selectedCategory?.id ?? null}
              onSelect={selectCategory}
            />
          </>
        ) : isLoading ? (
          <div className="h-64 flex items-center justify-center">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : chartData.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
            No transactions in this period.
          </div>
        ) : chartType === "bar" ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                interval={Math.max(0, Math.floor(barData.length / 8))}
              />
              <YAxis {...moneyAxisFor(barData, ["income", "expenses"], { fromZero: true })} tick={{ fontSize: 10 }} width={56} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip
                cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
                formatter={(value: number, name: string) => [formatCurrency(value), name]}
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95 }}
              />
              <Legend iconType="square" iconSize={8} formatter={(v) => <span className="text-xs text-foreground">{v}</span>} />
              {/* One stack, split by sign: income up from zero, expenses down. */}
              <Bar dataKey="income" name="Income" stackId="flow" fill={INCOME_COLOR} radius={[3, 3, 0, 0]} maxBarSize={36} />
              <Bar dataKey="expenses" name="Expenses" stackId="flow" fill={EXPENSE_COLOR} radius={[3, 3, 0, 0]} maxBarSize={36} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 4 }}>
              <defs>
                <linearGradient id="cfNetGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.2} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                dataKey="displayDate"
                tick={{ fontSize: 10 }}
                interval={Math.max(0, Math.floor(chartData.length / 8))}
              />
              <YAxis {...moneyAxisFor(chartData, ["net", "income", "expenses", "cmp_net"])} tick={{ fontSize: 10 }} width={56} />
              <Tooltip
                labelFormatter={(_, payload) => {
                  const iso = payload?.[0]?.payload?.date as string | undefined;
                  return iso ? fullDate(iso) : "";
                }}
                formatter={(value: number, name: string) => {
                  const labels: Record<string, string> = { net: "Net", income: "Income", expenses: "Expenses", cmp_net: "Prior Net" };
                  return [formatCurrency(value), labels[name] ?? name];
                }}
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95 }}
              />
              <Legend
                onClick={(e) => toggleSeries(String((e as { dataKey?: string }).dataKey ?? e.value))}
                formatter={(v) => {
                  const labels: Record<string, string> = { net: "Net", income: "Income", expenses: "Expenses", cmp_net: "Prior Net" };
                  const off = hiddenSeries.has(v);
                  return (
                    <span className={`text-xs cursor-pointer select-none ${off ? "text-muted-foreground line-through" : "text-foreground"}`}>
                      {labels[v] ?? v}
                    </span>
                  );
                }}
              />
              {/* Net drawn first so its filled band sits behind the income/expense lines */}
              <Area type="monotone" dataKey="net" stroke="#3b82f6" strokeWidth={2} fill="url(#cfNetGrad)" dot={false} name="net" hide={hiddenSeries.has("net")} />
              <Area type="monotone" dataKey="income" stroke="#22c55e" strokeWidth={1.5} fill="none" dot={false} name="income" hide={hiddenSeries.has("income")} />
              <Area type="monotone" dataKey="expenses" stroke="#ef4444" strokeWidth={1.5} fill="none" dot={false} name="expenses" hide={hiddenSeries.has("expenses")} />
              {compareRange && (
                <Area type="monotone" dataKey="cmp_net" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="4 2" fill="none" dot={false} name="cmp_net" hide={hiddenSeries.has("cmp_net")} />
              )}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Transaction table ──────────────────────────────────────────────── */}
      <div>
        <h3 className="text-base font-semibold mb-3">
          Transactions
          {selectedCategory && (
            <>
              <span className="ml-2 text-sm font-normal text-muted-foreground">· {selectedCategory.name}</span>
              <button className="ml-2 text-xs text-primary underline font-normal" onClick={() => setSelectedCategory(null)}>Clear filter</button>
            </>
          )}
        </h3>
        <TransactionTable
          key={`cf-${range?.from ?? "all"}-${range?.to ?? "all"}-${accountId ?? "all"}-${selectedCategory?.id ?? "all"}`}
          externalFilters={{
            date_from: range?.from,
            date_to: range?.to,
            account_id: accountId,
            category_id: selectedCategory?.id,
          }}
        />
      </div>
    </div>
  );
}

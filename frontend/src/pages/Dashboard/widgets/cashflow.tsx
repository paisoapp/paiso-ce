import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Legend, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { AlertTriangle } from "@/lib/icons";
import { EXPENSE_COLOR, INCOME_COLOR, slotColor } from "@/lib/chartPalette";
import { useBudgetTrend, useExpenses, useIncome } from "@/hooks/useBudget";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { CashFlowSankey } from "@/pages/Budgeting/CashFlowSankey";
import { useBudgetProgress } from "@/hooks/useBudgetPlan";
import { useDashboardData } from "@/hooks/useDashboard";
import { cashFlowHref } from "@/lib/navTargets";
import { formatCurrency, cn } from "@/lib/utils";
import { EmptyState, StatCard, WidgetCard, WidgetSkeleton, tooltipStyle, useChartDark } from "./common";
import { formatDate } from "@/lib/dates";
import { moneyAxisFor } from "@/lib/chartTicks";
import { SpendingPaceChart, useSpendingPace } from "@/components/cashflow/SpendingPaceChart";
import { barColor } from "@/pages/Budgeting/budget/bucketMeta";

function isoDate(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── Stat cards ──────────────────────────────────────────────────────────────

export function MonthlyIncomeStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return <StatCard label="Income (This Month)" value={formatCurrency(data.monthly_income)} accent="text-success" to={cashFlowHref("income")} />;
}

export function MonthlyExpensesStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return <StatCard label="Expenses (This Month)" value={formatCurrency(data.monthly_expenses)} accent="text-destructive" to={cashFlowHref("expenses")} />;
}

export function NetCashFlowStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  const net = data.monthly_income - data.monthly_expenses;
  return (
    <StatCard
      label="Net Cash Flow (This Month)"
      value={`${net >= 0 ? "+" : "−"}${formatCurrency(Math.abs(net))}`}
      accent={net >= 0 ? "text-success" : "text-destructive"}
      to={cashFlowHref("overview")}
    />
  );
}

export function SavingsRateWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  const rate = data.savings_rate;
  const clamped = Math.min(100, Math.max(0, rate));
  // Status colour (state, not identity), always paired with its label below.
  const color = clamped >= 20 ? "hsl(var(--success))" : clamped >= 10 ? "hsl(var(--warning))" : "hsl(var(--destructive))";
  const status = data.monthly_income <= 0 ? "No income yet this month" : clamped >= 20 ? "On track" : clamped >= 10 ? "Fair" : "Low";
  return (
    <Link
      to={cashFlowHref("overview")}
      className="h-full rounded-xl border border-border bg-card p-4 flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors hover:border-primary/50 hover:bg-muted/20"
    >
      <svg width="120" height="70" viewBox="0 0 100 60" role="img" aria-label={`Savings rate ${rate.toFixed(0)}%`}>
        <path d="M 10 55 A 40 40 0 0 1 90 55" fill="none" stroke="hsl(var(--muted))" strokeWidth="8" strokeLinecap="round" />
        <path
          d="M 10 55 A 40 40 0 0 1 90 55"
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${(clamped / 100) * 125.66} 125.66`}
        />
        <text x="50" y="52" textAnchor="middle" fontSize="14" fontWeight="bold" fill="currentColor">
          {rate.toFixed(0)}%
        </text>
      </svg>
      <p className="text-xs text-muted-foreground">Savings Rate · {status}</p>
    </Link>
  );
}

// ── Top expenses / month summary / recent ───────────────────────────────────

export function TopExpensesWidget() {
  const { data } = useDashboardData();
  const dark = useChartDark();
  if (!data) return <WidgetSkeleton />;
  // One series (spend by category) → one hue; the axis labels carry identity.
  const fill = slotColor(0, dark);
  return (
    <WidgetCard title="Top Expenses (This Month)" to={cashFlowHref("expenses")}>
      {data.top_expense_categories.length === 0 ? (
        <EmptyState>No expenses this month.</EmptyState>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data.top_expense_categories} layout="vertical" margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
            <XAxis type="number" {...moneyAxisFor(data.top_expense_categories, ["total"], { fromZero: true })} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 10 }} width={96} stroke="hsl(var(--muted-foreground))" />
            <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} formatter={(v: number) => [formatCurrency(v), "Spent"]} contentStyle={tooltipStyle} />
            <Bar dataKey="total" fill={fill} radius={[0, 4, 4, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </WidgetCard>
  );
}

export function MonthSummaryWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  const net = data.monthly_income - data.monthly_expenses;
  const rows = [
    { label: "Income", value: formatCurrency(data.monthly_income), color: "text-success" },
    { label: "Expenses", value: formatCurrency(data.monthly_expenses), color: "text-destructive" },
    { label: "Net Cash Flow", value: `${net >= 0 ? "+" : "−"}${formatCurrency(Math.abs(net))}`, color: net >= 0 ? "text-success" : "text-destructive" },
    { label: "Savings Rate", value: `${data.savings_rate.toFixed(1)}%`, color: "" },
  ];
  return (
    <WidgetCard title="This Month Summary" to={cashFlowHref("overview")}>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{row.label}</span>
            <span className={cn("font-semibold tabular-nums", row.color)}>{row.value}</span>
          </div>
        ))}
        <p className="text-[11px] text-muted-foreground">Transfers and card payments excluded, as on Cash Flow.</p>
      </div>
    </WidgetCard>
  );
}

export function RecentTransactionsWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return (
    <WidgetCard title="Recent Transactions" to="/transactions/all">
      {data.recent_transactions.length === 0 ? (
        <EmptyState>No transactions yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.recent_transactions.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
              <div className="min-w-0">
                <p className="truncate text-foreground">{t.description || "—"}</p>
                <p className="text-[11px] text-muted-foreground">{formatDate(t.date)}</p>
              </div>
              <span className={cn("tabular-nums shrink-0", t.amount >= 0 ? "text-success font-medium" : "text-foreground")}>
                {t.amount >= 0 ? "+" : "−"}{formatCurrency(Math.abs(t.amount))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

// ── Spending this month against last month ──────────────────────────────────

export function SpendingPaceWidget() {
  const { data, isLoading } = useSpendingPace();
  if (isLoading || !data) return <WidgetSkeleton />;
  const nothing = data.total === 0 && data.previous_total === 0;
  return (
    <WidgetCard title="Spending This Month" to={cashFlowHref("expenses")}>
      {nothing ? (
        <EmptyState>No spending this month or last month yet.</EmptyState>
      ) : (
        <SpendingPaceChart data={data} />
      )}
    </WidgetCard>
  );
}

// ── Income vs expenses, last 6 months ───────────────────────────────────────

export function IncomeVsExpensesWidget() {
  const range = useMemo(() => {
    const now = new Date();
    return { date_from: isoDate(new Date(now.getFullYear(), now.getMonth() - 5, 1)), date_to: isoDate(now) };
  }, []);
  const { data, isLoading } = useBudgetTrend(range);
  if (isLoading) return <WidgetSkeleton />;
  // Expenses hang below the axis, as on the Cash Flow page: the two bars of a
  // month then read as in and out, not as two amounts to compare for height.
  const rows = (data ?? []).map((r) => ({ ...r, expenses: -r.expenses }));
  const hasData = rows.some((r) => r.income > 0 || r.expenses < 0);

  return (
    <WidgetCard title="Income vs Expenses · 6 Months" to={cashFlowHref("overview")}>
      {!hasData ? (
        <EmptyState>No income or expenses in the last six months.</EmptyState>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={rows} margin={{ left: 0, right: 4, top: 4, bottom: 0 }} stackOffset="sign">
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
            <YAxis {...moneyAxisFor(rows, ["income", "expenses"], { fromZero: true })} tick={{ fontSize: 10 }} width={48} stroke="hsl(var(--muted-foreground))" />
            <ReferenceLine y={0} stroke="hsl(var(--border))" />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
              formatter={(v: number, name: string) => [formatCurrency(v), name]}
              contentStyle={tooltipStyle}
            />
            <Legend iconType="square" iconSize={8} formatter={(v) => <span className="text-xs text-foreground">{v}</span>} />
            {/* One stack, split by sign: income up from zero, expenses down. */}
            <Bar dataKey="income" name="Income" stackId="flow" fill={INCOME_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
            <Bar dataKey="expenses" name="Expenses" stackId="flow" fill={EXPENSE_COLOR} radius={[4, 4, 0, 0]} maxBarSize={28} />
          </BarChart>
        </ResponsiveContainer>
      )}
    </WidgetCard>
  );
}

// ── Money flow (Sankey) ─────────────────────────────────────────────────────

/** Where income went, as on Cash Flow → Overview, at card size: categories
 *  only. Shares the Dashboard's date range with the trend charts beside it. */
export function MoneyFlowWidget() {
  const { dateRange, setDateRange } = useSectionDateRange("dashboard");
  const params = { date_from: dateRange?.from, date_to: dateRange?.to };
  const { data: income, isLoading: incomeLoading } = useIncome(params);
  const { data: expenses, isLoading: expensesLoading } = useExpenses(params);

  return (
    <WidgetCard
      title="Money Flow"
      to={cashFlowHref("overview")}
      headerExtra={
        <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />
      }
    >
      <CashFlowSankey
        compact
        incomeRows={income?.by_category ?? []}
        expenseRows={expenses?.by_category ?? []}
        isLoading={incomeLoading || expensesLoading}
      />
    </WidgetCard>
  );
}

// ── Budget progress ─────────────────────────────────────────────────────────

export function BudgetProgressWidget() {
  const { data, isLoading } = useBudgetProgress();
  if (isLoading) return <WidgetSkeleton />;

  if (!data?.enrolled) {
    return (
      <WidgetCard title="Budget Progress">
        <EmptyState>
          <span>
            No budget yet. <Link to={cashFlowHref("budget")} className="text-primary hover:underline">Set one up</Link> to track spending against it.
          </span>
        </EmptyState>
      </WidgetCard>
    );
  }

  const spentPct = data.total_budget > 0 ? (data.total_spent / data.total_budget) * 100 : 0;
  const overLines = data.lines.filter((l) => l.actual > l.available && l.available > 0)
    .sort((a, b) => (b.actual - b.available) - (a.actual - a.available))
    .slice(0, 3);

  return (
    <WidgetCard title="Budget Progress" to={cashFlowHref("budget")}>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="text-lg font-bold tabular-nums">{formatCurrency(data.total_spent)}</span>
          <span className="text-xs text-muted-foreground">of {formatCurrency(data.total_budget)}</span>
        </div>
        <div className="relative h-2 rounded-full bg-muted overflow-hidden" aria-label={`${spentPct.toFixed(0)}% of budget spent`}>
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, spentPct)}%`, background: barColor(data.total_spent, data.total_budget) }} />
          {data.is_current && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-foreground/60"
              style={{ left: `${Math.min(100, data.month_pct_elapsed)}%` }}
              title={`${data.month_pct_elapsed.toFixed(0)}% of the month elapsed`}
            />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {spentPct.toFixed(0)}% spent{data.is_current && ` · ${data.days_remaining} days left`}
          {data.safe_to_spend > 0 && ` · ${formatCurrency(data.safe_to_spend)} safe to spend`}
        </p>
        {overLines.length > 0 && (
          <ul className="space-y-1 pt-1">
            {overLines.map((l) => (
              <li key={l.category_id} className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle size={12} className="shrink-0" />
                <span className="truncate">{l.name}</span>
                <span className="ml-auto tabular-nums">over by {formatCurrency(l.actual - l.available)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </WidgetCard>
  );
}

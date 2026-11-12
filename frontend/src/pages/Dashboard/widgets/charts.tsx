import { useState } from "react";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { useExpenses, useIncome, useTransfers } from "@/hooks/useBudget";
import { useInvestmentsAllocation, useInvestmentsOverview } from "@/hooks/useInvestmentsOverview";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import { cashFlowHref } from "@/lib/navTargets";
import { ExpenseChart, ExpenseTrendChart, expenseChartData } from "@/pages/Budgeting/ExpensesPage";
import { IncomeChart, IncomeTrendChart, incomeChartData } from "@/pages/Budgeting/IncomePage";
import { TransfersNetChart } from "@/pages/Budgeting/TransfersPage";
import { AssetClassDonut, useClassColors } from "@/pages/Investments/AssetMix";
import { InvestmentsPerformanceChart } from "@/pages/Investments/InvestmentsPerformanceChart";
import { PortfolioTrendChart } from "@/pages/Investments/StocksPage";
import { TransactionsByTypeDonut } from "@/pages/Transactions/TransactionBreakdown";
import { EmptyState, WidgetCard, WidgetSkeleton, useChartDark } from "./common";

/**
 * Dashboard versions of charts that live on other pages. Each renders
 * the page's own chart component, so the two cannot drift apart, and follows
 * the dashboard's shared date range where it has one. None is on the default
 * dashboard: a user adds the ones they want from "Add widget".
 */

/** The dashboard's date range, and the picker for a card's header. */
function useDashboardRange() {
  const { dateRange, setDateRange } = useSectionDateRange("dashboard");
  const picker = <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />;
  return { dateRange, picker };
}

// ── Investments ─────────────────────────────────────────────────────────────

/** Every priced holding, at its market price, over the dashboard's range;
 *  Today is the intraday line. The chart brings its own card. */
export function HoldingsPerformanceWidget() {
  return (
    <PortfolioTrendChart
      className="h-full"
      rangeSection="dashboard"
      title="Holdings Performance"
      overlayTickers={[]}
      onToggleOverlay={() => {}}
      onClearOverlays={() => {}}
    />
  );
}

export function InvestmentsByTypeWidget() {
  const { dateRange, picker } = useDashboardRange();
  return (
    <WidgetCard title="Investments by Type" to="/investments/overview" headerExtra={picker}>
      <InvestmentsPerformanceChart dateRange={dateRange} height={200} />
    </WidgetCard>
  );
}

export function AssetClassesWidget() {
  const { data, isLoading } = useInvestmentsAllocation(true);
  const colors = useClassColors(data?.asset_classes ?? []);
  if (isLoading) return <WidgetSkeleton />;
  return (
    <WidgetCard title="Asset Classes" to="/investments/overview">
      {!data || data.by_asset_class.length === 0 ? (
        <EmptyState>No investments to classify yet.</EmptyState>
      ) : (
        <AssetClassDonut slices={data.by_asset_class} total={data.total} colors={colors} />
      )}
    </WidgetCard>
  );
}

const PLAN_TABS = {
  retirement: { title: "Retirement Plans", noun: "retirement", to: "/investments/retirement" },
  education: { title: "Education Plans", noun: "education", to: "/investments/education" },
  health: { title: "Health Plans", noun: "health", to: "/investments/health" },
} as const;

/** One Investments plan tab's line: its plans' value summed, daily. */
function PlanTabWidget({ purpose }: { purpose: keyof typeof PLAN_TABS }) {
  const tab = PLAN_TABS[purpose];
  const { data, isLoading } = useInvestmentsOverview();
  if (isLoading) return <WidgetSkeleton />;
  const ids = (data?.groups.find((g) => g.purpose === purpose)?.accounts ?? [])
    .filter((c) => c.kind === "account" && c.id != null)
    .map((c) => c.id!);
  if (ids.length === 0) {
    return (
      <WidgetCard title={tab.title} to={tab.to}>
        <EmptyState>No {tab.noun} accounts yet.</EmptyState>
      </WidgetCard>
    );
  }
  return (
    <PortfolioTrendChart
      className="h-full"
      rangeSection="dashboard"
      plansMode
      accountIds={ids}
      title={tab.title}
      overlayTickers={[]}
      onToggleOverlay={() => {}}
      onClearOverlays={() => {}}
    />
  );
}

export const RetirementPlansWidget = () => <PlanTabWidget purpose="retirement" />;
export const EducationPlansWidget = () => <PlanTabWidget purpose="education" />;
export const HealthPlansWidget = () => <PlanTabWidget purpose="health" />;

// ── Budgeting ───────────────────────────────────────────────────────────────

export function ExpensesByCategoryWidget() {
  const dark = useChartDark();
  const { dateRange, picker } = useDashboardRange();
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isLoading } = useExpenses({ date_from: dateRange?.from, date_to: dateRange?.to });
  return (
    <WidgetCard title="Expenses by Category" to={cashFlowHref("expenses")} headerExtra={picker}>
      <ExpenseChart chartType="donut" chartData={expenseChartData(data?.by_category ?? [], dark)}
        selectedCategory={selected} onSelect={setSelected} isLoading={isLoading} />
    </WidgetCard>
  );
}

export function ExpensesOverTimeWidget() {
  const { dateRange, picker } = useDashboardRange();
  return (
    <WidgetCard title="Expenses Over Time" to={cashFlowHref("expenses")} headerExtra={picker}>
      <ExpenseTrendChart trendParams={{ date_from: dateRange?.from, date_to: dateRange?.to }} isLoading={false} />
    </WidgetCard>
  );
}

export function IncomeBySourceWidget() {
  const dark = useChartDark();
  const { dateRange, picker } = useDashboardRange();
  const [selected, setSelected] = useState<number | null>(null);
  const { data, isLoading } = useIncome({ date_from: dateRange?.from, date_to: dateRange?.to });
  return (
    <WidgetCard title="Income by Source" to={cashFlowHref("income")} headerExtra={picker}>
      <IncomeChart chartType="donut" chartData={incomeChartData(data?.by_category ?? [], undefined, dark)}
        compareRange={null} selectedCategory={selected} onSelect={setSelected}
        isLoading={isLoading} total={data?.total ?? 0} />
    </WidgetCard>
  );
}

export function IncomeOverTimeWidget() {
  const { dateRange, picker } = useDashboardRange();
  return (
    <WidgetCard title="Income Over Time" to={cashFlowHref("income")} headerExtra={picker}>
      <IncomeTrendChart trendParams={{ date_from: dateRange?.from, date_to: dateRange?.to }} isLoading={false} />
    </WidgetCard>
  );
}

export function TransfersByCategoryWidget() {
  const { dateRange, picker } = useDashboardRange();
  const { data, isLoading } = useTransfers({ date_from: dateRange?.from, date_to: dateRange?.to });
  const rows = data?.by_category ?? [];
  return (
    <WidgetCard title="Transfers by Category" to={cashFlowHref("transfers")} headerExtra={picker}>
      {isLoading ? <WidgetSkeleton /> : rows.some((c) => c.net !== 0)
        ? <TransfersNetChart rows={rows} />
        : <EmptyState>No transfers in this period.</EmptyState>}
    </WidgetCard>
  );
}

// ── Transactions ────────────────────────────────────────────────────────────

export function TransactionsByTypeWidget() {
  const { dateRange, picker } = useDashboardRange();
  return (
    <WidgetCard title="Transactions by Account Type" to="/transactions" headerExtra={picker}>
      <TransactionsByTypeDonut dateFrom={dateRange?.from} dateTo={dateRange?.to} />
    </WidgetCard>
  );
}


import type { ComponentType } from "react";
import type { DashboardLayout, DashboardWidgetSize } from "@/store/uiPrefs";
import {
  AccountSummaryWidget, AssetMixWidget, AssetsLiabilitiesTrendWidget, BalanceSheetWidget, DebtOverviewWidget,
  NetWorthStat, BalanceTrendWidget, NetWorthBarsWidget, NetWorthFlowWidget, NetWorthTrendWidget, TotalAssetsStat, TotalLiabilitiesStat,
} from "./overview";
import {
  BudgetProgressWidget, IncomeVsExpensesWidget, MoneyFlowWidget, MonthSummaryWidget, MonthlyExpensesStat,
  MonthlyIncomeStat, NetCashFlowStat, RecentTransactionsWidget, SavingsRateWidget, SpendingPaceWidget,
  TopExpensesWidget,
} from "./cashflow";
import {
  DividendIncomeWidget, FeeAnalysisWidget, InvestmentsStat, TopHoldingsWidget,
} from "./investments";
import {
  AssetClassesWidget, EducationPlansWidget, ExpensesByCategoryWidget, ExpensesOverTimeWidget,
  HealthPlansWidget, HoldingsPerformanceWidget, IncomeBySourceWidget, IncomeOverTimeWidget,
  InvestmentsByTypeWidget, RetirementPlansWidget, TransactionsByTypeWidget, TransfersByCategoryWidget,
} from "./charts";

export type WidgetCategory = "overview" | "cashflow" | "investments" | "transactions";

export const CATEGORY_LABELS: Record<WidgetCategory, string> = {
  overview: "Net worth & accounts",
  cashflow: "Cash flow & budget",
  investments: "Investments",
  transactions: "Transactions",
};

export interface WidgetDef {
  id: string;
  title: string;
  description: string;
  category: WidgetCategory;
  kind: "card" | "chart" | "table";
  defaultSize: DashboardWidgetSize;
  /** Sizes this widget reads well at. The first is the smallest. */
  sizes: DashboardWidgetSize[];
  /** For a chart: the files (under src/) whose chart it shows. Every chart in
   *  the app is either named here or marked `dashboard-catalog: not offered`
   *  in its own file; scripts/check-charts.mjs fails the build otherwise, so a
   *  new chart is always offered in "Add widget". */
  sources?: string[];
  Component: ComponentType;
}

const STAT: DashboardWidgetSize[] = ["sm", "md"];
/** The size list of the one-number tiles, which the grid does not stretch. */
export const STAT_SIZES = STAT;
const PANEL: DashboardWidgetSize[] = ["md", "lg"];
const FLEX: DashboardWidgetSize[] = ["sm", "md", "lg"];

export const WIDGETS: WidgetDef[] = [
  // Overview
  { id: "net_worth", title: "Net Worth", description: "Assets minus liabilities, right now.",
    category: "overview", kind: "card", defaultSize: "sm", sizes: STAT, Component: NetWorthStat },
  { id: "total_assets", title: "Total Assets", description: "Everything you own, including cash and property.",
    category: "overview", kind: "card", defaultSize: "sm", sizes: STAT, Component: TotalAssetsStat },
  { id: "total_liabilities", title: "Total Liabilities", description: "Credit cards, loans and mortgages.",
    category: "overview", kind: "card", defaultSize: "sm", sizes: STAT, Component: TotalLiabilitiesStat },
  { id: "net_worth_trend", title: "Net Worth Trend", description: "Net worth, with assets and liabilities, over any date range.",
    category: "overview", kind: "chart", defaultSize: "lg", sizes: PANEL, sources: ["components/portfolio/NetWorthTrendChart.tsx"], Component: NetWorthTrendWidget },
  { id: "assets_liabilities_trend", title: "Assets & Liabilities", description: "What you own and what you owe, each over time.",
    category: "overview", kind: "chart", defaultSize: "lg", sizes: PANEL, sources: ["components/portfolio/NetWorthTrendChart.tsx"], Component: AssetsLiabilitiesTrendWidget },
  { id: "net_worth_bars", title: "Net Worth Makeup", description: "Assets and liabilities as bars over time, with net worth drawn across them.",
    category: "overview", kind: "chart", defaultSize: "lg", sizes: PANEL, sources: ["components/portfolio/NetWorthTrendChart.tsx"], Component: NetWorthBarsWidget },
  { id: "net_worth_flow", title: "Net Worth Flow", description: "Sankey of your assets by kind, flowing into what you owe and your net worth.",
    category: "overview", kind: "chart", defaultSize: "lg", sizes: PANEL, sources: ["components/portfolio/NetWorthTrendChart.tsx", "components/portfolio/NetWorthSankey.tsx"], Component: NetWorthFlowWidget },
  { id: "balance_trend", title: "Balances by Account Type", description: "Cash, investments, cards, loans and mortgages, each as a line over time.",
    category: "overview", kind: "chart", defaultSize: "lg", sizes: PANEL, sources: ["components/portfolio/BalanceTrendCard.tsx"], Component: BalanceTrendWidget },
  { id: "asset_mix", title: "Asset Mix", description: "Donut of where your assets sit, by account type.",
    category: "overview", kind: "chart", defaultSize: "md", sizes: PANEL, sources: ["components/portfolio/AssetBreakdownDonut.tsx"], Component: AssetMixWidget },
  { id: "balance_sheet", title: "Balance Sheet", description: "Assets, liabilities and net worth side by side.",
    category: "overview", kind: "card", defaultSize: "md", sizes: FLEX, Component: BalanceSheetWidget },
  { id: "account_summary", title: "Account Summary", description: "Table of every account group with balances and share.",
    category: "overview", kind: "table", defaultSize: "lg", sizes: PANEL, Component: AccountSummaryWidget },
  { id: "debt_overview", title: "Debt Overview", description: "Every card, loan and mortgage, largest first.",
    category: "overview", kind: "card", defaultSize: "md", sizes: FLEX, Component: DebtOverviewWidget },

  // Cash flow
  { id: "monthly_income", title: "Income", description: "Income so far this month, transfers excluded.",
    category: "cashflow", kind: "card", defaultSize: "sm", sizes: STAT, Component: MonthlyIncomeStat },
  { id: "monthly_expenses", title: "Expenses", description: "Spending so far this month, transfers excluded.",
    category: "cashflow", kind: "card", defaultSize: "sm", sizes: STAT, Component: MonthlyExpensesStat },
  { id: "net_cash_flow", title: "Net Cash Flow", description: "Income minus expenses this month.",
    category: "cashflow", kind: "card", defaultSize: "sm", sizes: STAT, Component: NetCashFlowStat },
  { id: "savings_rate", title: "Savings Rate", description: "Share of this month's income you kept.",
    category: "cashflow", kind: "chart", defaultSize: "sm", sizes: STAT, Component: SavingsRateWidget },
  { id: "spending_pace", title: "Spending This Month", description: "Spending so far this month, day by day, against last month.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["components/cashflow/SpendingPaceChart.tsx"], Component: SpendingPaceWidget },
  { id: "top_expenses", title: "Top Expenses", description: "Your five biggest spending categories this month.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: FLEX, Component: TopExpensesWidget },
  { id: "month_summary", title: "This Month Summary", description: "Income, expenses, net and savings rate.",
    category: "cashflow", kind: "card", defaultSize: "md", sizes: FLEX, Component: MonthSummaryWidget },
  { id: "recent_transactions", title: "Recent Transactions", description: "The five most recent transactions.",
    category: "cashflow", kind: "table", defaultSize: "md", sizes: FLEX, Component: RecentTransactionsWidget },
  { id: "income_vs_expenses", title: "Income vs Expenses", description: "Monthly income and spending, last six months.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: PANEL,
    Component: IncomeVsExpensesWidget },
  { id: "money_flow", title: "Money Flow", description: "Sankey of where your income went, by category.",
    category: "cashflow", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Budgeting/CashFlowSankey.tsx"], Component: MoneyFlowWidget },
  { id: "budget_progress", title: "Budget Progress", description: "Spending against this month's budget.",
    category: "cashflow", kind: "card", defaultSize: "md", sizes: FLEX,
    Component: BudgetProgressWidget },

  // Investments
  { id: "investments", title: "Investments", description: "Invested value and gain on cost basis.",
    category: "investments", kind: "card", defaultSize: "sm", sizes: STAT, Component: InvestmentsStat },
  { id: "top_holdings", title: "Top Holdings", description: "Largest positions, or today's biggest movers.",
    category: "investments", kind: "table", defaultSize: "md", sizes: FLEX,
    Component: TopHoldingsWidget },
  { id: "fee_analysis", title: "Fee Analysis", description: "What your funds cost each year, and over ten.",
    category: "investments", kind: "card", defaultSize: "md", sizes: PANEL, Component: FeeAnalysisWidget },
  { id: "investment_income", title: "Investment Income", description: "Dividends and interest this year, by month.",
    category: "investments", kind: "chart", defaultSize: "md", sizes: FLEX,
    Component: DividendIncomeWidget },
  { id: "holdings_performance", title: "Holdings Performance", description: "Every holding at its market price over any range, with today's intraday line.",
    category: "investments", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Investments/StocksPage.tsx"],
    Component: HoldingsPerformanceWidget },
  { id: "investments_by_type", title: "Investments by Type", description: "Investments over time, by type, by tax treatment or as one total.",
    category: "investments", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Investments/InvestmentsPerformanceChart.tsx"],
    Component: InvestmentsByTypeWidget },
  { id: "asset_classes", title: "Asset Classes", description: "Donut of your investments by stocks, bonds, cash and the rest.",
    category: "investments", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["pages/Investments/AssetMix.tsx"],
    Component: AssetClassesWidget },
  { id: "retirement_plans", title: "Retirement Plans", description: "Your 401(k), IRA and other retirement plans, summed, over any range.",
    category: "investments", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Investments/StocksPage.tsx"], Component: RetirementPlansWidget },
  { id: "education_plans", title: "Education Plans", description: "Your 529 and other education plans, summed, over any range.",
    category: "investments", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Investments/StocksPage.tsx"], Component: EducationPlansWidget },
  { id: "health_plans", title: "Health Plans", description: "Your HSA and other health accounts, summed, over any range.",
    category: "investments", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Investments/StocksPage.tsx"], Component: HealthPlansWidget },

  // Budgeting charts
  { id: "expenses_by_category", title: "Expenses by Category", description: "Donut of spending by category over any range.",
    category: "cashflow", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Budgeting/ExpensesPage.tsx"],
    Component: ExpensesByCategoryWidget },
  { id: "expenses_over_time", title: "Expenses Over Time", description: "Spending per period over any range.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["pages/Budgeting/ExpensesPage.tsx"],
    Component: ExpensesOverTimeWidget },
  { id: "income_by_source", title: "Income by Source", description: "Donut of income by source over any range.",
    category: "cashflow", kind: "chart", defaultSize: "lg", sizes: PANEL,
    sources: ["pages/Budgeting/IncomePage.tsx"],
    Component: IncomeBySourceWidget },
  { id: "income_over_time", title: "Income Over Time", description: "Income per period over any range.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["pages/Budgeting/IncomePage.tsx"],
    Component: IncomeOverTimeWidget },
  { id: "transfers_by_category", title: "Transfers by Category", description: "Money moved between accounts, in and out, by category.",
    category: "cashflow", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["pages/Budgeting/TransfersPage.tsx"],
    Component: TransfersByCategoryWidget },

  // Transactions
  { id: "transactions_by_type", title: "Transactions by Account Type", description: "Donut of how many transactions each kind of account had.",
    category: "transactions", kind: "chart", defaultSize: "md", sizes: PANEL,
    sources: ["pages/Transactions/TransactionBreakdown.tsx"], Component: TransactionsByTypeWidget },
];

export const WIDGETS_BY_ID: Record<string, WidgetDef> = Object.fromEntries(WIDGETS.map((w) => [w.id, w]));

/** Today's dashboard, rebuilt from widgets — so nobody's view changes until
 *  they choose to customise it. */
const DEFAULT_LAYOUT: DashboardLayout = {
  version: 1,
  widgets: [
    { id: "net_worth", size: "sm" },
    { id: "monthly_income", size: "sm" },
    { id: "monthly_expenses", size: "sm" },
    { id: "investments", size: "sm" },
    { id: "spending_pace", size: "md" },
    { id: "top_expenses", size: "md" },
    { id: "asset_mix", size: "md" },
    // Two lists side by side, then the two short cards, so no row pairs a
    // short card with a tall one.
    { id: "recent_transactions", size: "md" },
    { id: "balance_sheet", size: "md" },
    { id: "savings_rate", size: "md" },
    { id: "month_summary", size: "md" },
  ],
};

/** Drop unknown or duplicate ids and sizes a widget doesn't support, so a
 *  layout saved by an older or newer build can never break the page. */
export function sanitizeLayout(raw: DashboardLayout | null | undefined): DashboardLayout {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.widgets)) return DEFAULT_LAYOUT;
  const seen = new Set<string>();
  const widgets = raw.widgets.flatMap((p) => {
    const def = p && WIDGETS_BY_ID[p.id];
    if (!def || seen.has(p.id)) return [];
    seen.add(p.id);
    return [{ id: p.id, size: def.sizes.includes(p.size) ? p.size : def.defaultSize }];
  });
  return { version: 1, widgets };
}

// ── Recommendations ─────────────────────────────────────────────────────────

interface RecommendationContext {
  investmentValue: number;
  hasDebt: boolean;
  budgetEnrolled: boolean;
  hasHoldings: boolean;
}

export interface Recommendation {
  id: string;
  reason: string;
}

/** Widgets worth suggesting for what this user actually has. Never suggests a
 *  widget already placed. */
export function recommendWidgets(ctx: RecommendationContext, placed: Set<string>): Recommendation[] {
  const out: Recommendation[] = [];
  const add = (id: string, reason: string) => {
    const def = WIDGETS_BY_ID[id];
    if (def && !placed.has(id)) out.push({ id, reason });
  };
  add("account_summary", "See every account group in one table.");
  // Dashboards saved before it was added do not have it.
  add("spending_pace", "See how this month's spending compares with last month.");
  if (ctx.investmentValue > 0) {
    add("net_worth_trend", "Track how your net worth moves over time.");
    add("fee_analysis", "You hold funds. See what they cost you.");
  }
  if (ctx.hasHoldings) add("top_holdings", "Keep an eye on your largest positions.");
  if (ctx.hasDebt) add("debt_overview", "You have debts on file. See them side by side.");
  if (ctx.budgetEnrolled) add("budget_progress", "You have a budget. Track it here.");
  return out;
}

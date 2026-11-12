import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatMonthShort, formatShortDate } from "@/lib/dates";

export interface CategoryTotal {
  category_id: number | null;
  category_name: string;
  color: string | null;
  parent_id: number | null;
  total: number;
  count: number;
}

interface ComparePeriod {
  by_category: CategoryTotal[];
  total: number;
}

interface BudgetSummary {
  period: { from: string; to: string };
  by_category: CategoryTotal[];
  /** Absent on the transfers endpoint, which has no Sankey. */
  total: number;
  compare: ComparePeriod | null;
}

interface CashFlowDay {
  date: string;
  income: number;
  expenses: number;
  net: number;
}

interface CashFlowSummary {
  period: { from: string; to: string };
  series: CashFlowDay[];
  compare_series: CashFlowDay[] | null;
}

function buildQS(params: BudgetParams): string {
  const p = new URLSearchParams();
  if (params.date_from) p.set("date_from", params.date_from);
  if (params.date_to) p.set("date_to", params.date_to);
  if (params.compare_from) p.set("compare_from", params.compare_from);
  if (params.compare_to) p.set("compare_to", params.compare_to);
  if (params.account_id) p.set("account_id", String(params.account_id));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export interface BudgetParams {
  date_from?: string;
  date_to?: string;
  compare_from?: string;
  compare_to?: string;
  account_id?: number;
}

export function useExpenses(params: BudgetParams = {}, options: { enabled?: boolean } = {}) {
  return useQuery<BudgetSummary>({
    queryKey: ["budget", "expenses", params],
    queryFn: () => api.get<BudgetSummary>(`/budget/expenses${buildQS(params)}`),
    enabled: options.enabled ?? true,
  });
}

export function useIncome(params: BudgetParams = {}, options: { enabled?: boolean } = {}) {
  return useQuery<BudgetSummary>({
    queryKey: ["budget", "income", params],
    queryFn: () => api.get<BudgetSummary>(`/budget/income${buildQS(params)}`),
    enabled: options.enabled ?? true,
  });
}

export function useCashFlow(params: BudgetParams = {}) {
  return useQuery<CashFlowSummary>({
    queryKey: ["budget", "cashflow", params],
    queryFn: () => api.get<CashFlowSummary>(`/budget/cashflow${buildQS(params)}`),
  });
}

interface TransferCategory {
  category_id: number;
  category_name: string;
  color: string | null;
  net: number;
  inflow: number;
  outflow: number;
  count: number;
}

interface TransfersSummary {
  period: { from: string | null; to: string | null };
  by_category: TransferCategory[];
  total_in: number;
  total_out: number;
  total_net: number;
}

export function useTransfers(params: BudgetParams = {}) {
  return useQuery<TransfersSummary>({
    queryKey: ["budget", "transfers", params],
    queryFn: () => api.get<TransfersSummary>(`/budget/transfers${buildQS(params)}`),
  });
}

interface MonthlyTrend {
  month: string;
  label: string;
  income: number;
  expenses: number;
}

/** Return the ISO date string of the Monday that starts the week containing `isoDate`. */
function weekStartISO(isoDate: string): string {
  const d = new Date(isoDate + "T12:00:00");
  const day = d.getDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day; // shift to Monday
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Granularity = "daily" | "weekly" | "monthly";

function granularityFor(date_from?: string, date_to?: string): Granularity {
  if (!date_from || !date_to) return "monthly";
  const diff = (new Date(date_to).getTime() - new Date(date_from).getTime()) / 86400000;
  if (diff <= 31) return "daily";
  if (diff <= 90) return "weekly";
  return "monthly";
}

/**
 * Groups a daily cash-flow series into points a chart can hold. Granularity
 * adapts to the range:
 *   ≤ 31 days  → daily data points
 *   32–90 days → weekly aggregation (week starts Monday)
 *   > 90 days  → monthly aggregation
 * Expenses come back as a positive amount.
 */
export function bucketCashFlow(series: CashFlowDay[], date_from?: string, date_to?: string): MonthlyTrend[] {
  const granularity = granularityFor(date_from, date_to);

  if (granularity === "daily") {
    return series.map((day) => {
      return {
        month: day.date,
        label: formatShortDate(day.date),
        income: day.income,
        expenses: Math.abs(day.expenses),
      };
    });
  }

  const totals = new Map<string, { income: number; expenses: number }>();
  for (const day of series) {
    const key = granularity === "weekly" ? weekStartISO(day.date) : day.date.slice(0, 7);
    const prev = totals.get(key) ?? { income: 0, expenses: 0 };
    totals.set(key, {
      income: prev.income + day.income,
      expenses: prev.expenses + Math.abs(day.expenses),
    });
  }
  return Array.from(totals.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => {
      if (granularity === "weekly") {
        return { month: key, label: formatShortDate(key), ...v };
      }
      return {
        month: key,
        label: formatMonthShort(key),
        ...v,
      };
    });
}

/**
 * Derives an income/expenses trend from the cashflow endpoint.
 * Granularity adapts to the selected date range:
 *   ≤ 31 days  → daily data points
 *   32–90 days → weekly aggregation (week starts Monday)
 *   > 90 days  → monthly aggregation
 */
export function useBudgetTrend(params: BudgetParams = {}) {
  const granularity = granularityFor(params.date_from, params.date_to);

  return useQuery<MonthlyTrend[]>({
    queryKey: ["budget", "trend", params, granularity],
    queryFn: async () => {
      const data = await api.get<CashFlowSummary>(`/budget/cashflow${buildQS(params)}`);
      return bucketCashFlow(data.series, params.date_from, params.date_to);
    },
    staleTime: 5 * 60 * 1000,
  });
}

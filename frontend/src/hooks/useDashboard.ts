import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { FeeAnalysis } from "@/hooks/usePortfolio";

interface DashboardData {
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  investment_value: number;
  asset_breakdown: { label: string; value: number }[];
  total_cash: number;
  property_value: number;
  other_asset_value: number;
  total_cost_basis: number;
  /** Value of the holdings that have a cost basis — what total_gain is measured on. */
  costed_value: number;
  total_gain: number;
  fee_analysis: FeeAnalysis;
  /** This month, transfers excluded — the same figures as Budgeting. */
  monthly_income: number;
  monthly_expenses: number;
  savings_rate: number;
  top_expense_categories: { name: string; color: string | null; total: number }[];
  recent_transactions: { id: number; date: string; description: string; amount: number }[];
}

/** One request feeds every summary widget; widgets sharing it dedupe. */
export function useDashboardData() {
  return useQuery<DashboardData>({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardData>("/dashboard"),
  });
}

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TrendSession } from "@/hooks/usePortfolioTrend";

/** A fund the portfolio holds with no expense ratio on file. */
export interface UnknownFund {
  name: string;
  ticker: string | null;
  source: "holding";
  value: number;
}

export interface FeeCostRow {
  name: string;
  ticker: string | null;
  source: "holding";
  value: number;
  annual_fee: number;
  /** Percent (0.03 = 0.03%). */
  expense_ratio: number;
}

export interface FeeAnalysis {
  /** Value held in funds/securities that can carry a fund fee. */
  fee_bearing_value: number;
  /** Portion of fee_bearing_value whose expense ratio is known. */
  er_known_value: number;
  coverage_pct: number;
  /** Percent, weighted over er_known_value only. */
  weighted_expense_ratio: number;
  annual_fee: number;
  projected_fee_cost: number;
  projection_years: number;
  projection_growth_pct: number;
  /** Positions with no expense ratio; one fund in two accounts counts twice. */
  unknown_count: number;
  /** Distinct funds behind those positions — the number worth showing. */
  unknown_fund_count: number;
  unknown_value: number;
  /** Which funds they are, largest holding first. May be shorter than
   *  `unknown_fund_count`, which the server caps. */
  unknown_funds: UnknownFund[];
  top_costs: FeeCostRow[];
}

interface PortfolioSummary {
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  investment_value: number;
  total_cost_basis: number;
  /** Value of the holdings that have a cost basis — what total_gain is measured on. */
  costed_value: number;
  total_gain: number;
  total_cash: number;
  property_value: number;
  other_asset_value: number;
  total_loan_balance: number;
  /** Debt from standalone loan/mortgage accounts (excludes asset-backed loans). */
  total_loan_account_balance: number;
  total_cc_balance: number;
  weighted_expense_ratio: number;
  annual_fee_drag: number;
  fee_analysis: FeeAnalysis;
  asset_breakdown: { label: string; value: number }[];
}

export interface AccountRow {
  id: number;
  name: string;
  type: string;
  type_label: string;
  institution: string | null;
  currency: string;
  balance?: number;
  value?: number;
  /** Excluded from net worth: listed, not summed. */
  excluded?: boolean;
}

export interface AssetRow {
  id: number;
  name: string;
  type: string;
  type_label: string;
  property_value?: number;
  loan_balance: number;
  equity?: number;
  value?: number;
  exclude_from_net_worth?: boolean;
}

interface PortfolioBreakdown {
  cash: AccountRow[];
  investments: AccountRow[];
  credit_cards: AccountRow[];
  loans: AccountRow[];
  mortgages: AssetRow[];
  other_assets: AssetRow[];
}

export interface NetWorthPoint {
  date: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  /** Balances by kind of account. Debts are positive amounts owed. */
  cash: number;
  investments: number;
  credit_cards: number;
  loans: number;
  mortgages: number;
}

interface NetWorthTrend {
  series: NetWorthPoint[];
}

export function usePortfolioSummary() {
  return useQuery<PortfolioSummary>({
    queryKey: ["portfolio", "summary"],
    queryFn: () => api.get<PortfolioSummary>("/portfolio/summary"),
  });
}

export function usePortfolioBreakdown() {
  return useQuery<PortfolioBreakdown>({
    queryKey: ["portfolio", "breakdown"],
    queryFn: () => api.get<PortfolioBreakdown>("/portfolio/breakdown"),
  });
}

export function useNetWorthTrend(dateFrom?: string, dateTo?: string) {
  const params = new URLSearchParams();
  if (dateFrom) params.set("date_from", dateFrom);
  if (dateTo) params.set("date_to", dateTo);
  const qs = params.toString();
  return useQuery<NetWorthTrend>({
    queryKey: ["portfolio", "net-worth-trend", dateFrom, dateTo],
    queryFn: () => api.get<NetWorthTrend>(`/portfolio/net-worth-trend${qs ? `?${qs}` : ""}`),
    staleTime: 5 * 60 * 1000,
  });
}

/** Net worth through the latest market session, for a "Today" range: priced
 *  holdings bar by bar, everything else flat. Empty when nothing the
 *  user holds is priced intraday. */
interface NetWorthIntraday {
  series: Pick<NetWorthPoint, "date" | "net_worth" | "total_assets" | "total_liabilities">[];
  session: TrendSession | null;
}

export function useNetWorthIntraday(enabled: boolean) {
  return useQuery<NetWorthIntraday>({
    queryKey: ["portfolio", "net-worth-intraday"],
    queryFn: () => api.get<NetWorthIntraday>("/portfolio/net-worth-intraday"),
    enabled,
    staleTime: 60_000,
    refetchInterval: enabled ? 60_000 : false,
  });
}

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface OverviewCard {
  /** "account", or money on no account: a standalone 529 plan, option grants. */
  kind: "account";
  id: number | null;
  name: string;
  institution: string | null;
  /** Excluded from net worth: dimmed, but still counted on Investments. */
  excluded?: boolean;
  /** The part of `value` net worth leaves out: all of it for an excluded
   *  account, else the holdings excluded one by one. */
  excluded_value?: number;
  account_type: string;
  /** Market value, including anything excluded from net worth. */
  value: number;
  /** positions | balance */
  value_source: string;
  value_as_of: string | null;
  subtype: string | null;
  subtype_label: string | null;
  /** The account's investment type (the tab it is on). */
  purpose: string | null;
  purpose_label: string | null;
  investment_type?: string | null;
  tax_treatment: string | null;
  tax_treatment_label: string | null;
  /** A hand-kept plan: what it holds beyond its tickers, as last entered. */
  other_funds_value?: number | null;
  other_funds_as_of?: string | null;
  other_funds_prev_value?: number | null;
  contributions_total?: number | null;
  hsa_coverage?: "self" | "family" | null;
  /** When the user last typed a value this plan depends on; null when nothing
   *  hand-typed can go stale (tickers, synced plans). */
  updated_by_hand_on?: string | null;
  /** The hand-typed value is older than `manual_price_stale_days`. */
  stale?: boolean;
}

interface OverviewGroup {
  purpose: string;
  label: string;
  total: number;
  /** tax_deferred | tax_free | taxable | not_set → value */
  by_tax: Record<string, number>;
  accounts: OverviewCard[];
}

interface InvestmentsOverview {
  /** Market value of every investment account, excluded ones included. */
  total: number;
  /** The part of `total` net worth leaves out; the Dashboard shows the rest. */
  excluded_total: number;
  by_tax: Record<string, number>;
  tax_labels: Record<string, string>;
  groups: OverviewGroup[];
  /** Hand-typed prices older than `manual_price_stale_days`. */
  stale_manual_prices: number;
  manual_price_stale_days: number;
}

export function useInvestmentsOverview() {
  return useQuery<InvestmentsOverview>({
    // Under "portfolio" so anything that changes a value refreshes it.
    queryKey: ["portfolio", "investments-overview"],
    queryFn: () => api.get<InvestmentsOverview>("/investments/overview"),
  });
}

interface AllocationSlice {
  key: string;
  label: string;
  value: number;
}

interface AllocationGroup {
  key: string;
  label: string;
  total: number;
  asset_classes: AllocationSlice[];
}

interface InvestmentsAllocation {
  total: number;
  /** Every asset class in display order — the order fixes each one's colour. */
  asset_classes: { key: string; label: string }[];
  by_asset_class: AllocationSlice[];
  by_purpose: AllocationGroup[];
  by_tax: AllocationGroup[];
}

export function useInvestmentsAllocation(enabled = true, accountId?: number) {
  return useQuery<InvestmentsAllocation>({
    queryKey: ["portfolio", "investments-allocation", accountId ?? "all"],
    queryFn: () => api.get<InvestmentsAllocation>(
      `/investments/allocation${accountId ? `?account_id=${accountId}` : ""}`),
    enabled,
  });
}

/** Each account's market value per day over a date range (account_history),
 *  counting what the user excluded from net worth, as Investments does. */
export function useAccountValueHistory(range: { from: string; to: string } | null) {
  const to = range?.to ?? new Date().toISOString().slice(0, 10);
  const from = range?.from ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
  return useQuery<{ series: Record<string, { date: string; balance: number }[]> }>({
    queryKey: ["portfolio", "account-value-history", from, to, "with-excluded"],
    queryFn: () => api.get(`/accounts/balance-history?date_from=${from}&date_to=${to}&include_excluded=true`),
  });
}

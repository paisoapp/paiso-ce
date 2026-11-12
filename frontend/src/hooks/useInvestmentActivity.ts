import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { TradeAction } from "@/hooks/useHoldings";

export type ActivityKind = "trades" | "income" | "transfers" | "other";

interface ActivityFilters {
  date_from?: string;
  date_to?: string;
  account_id?: number;
  kind?: ActivityKind;
  search?: string;
  page?: number;
  page_size?: number;
}

/** One buy, sale, dividend, fee or transfer on a holding. */
export interface ActivityItem {
  id: number;
  holding_id: number;
  account_id: number;
  account_name: string;
  ticker: string | null;
  security_name: string;
  trade_date: string;
  action: TradeAction;
  /** null when the action moves no shares (a dividend, a fee). */
  shares: number | null;
  price_per_share: number | null;
  split_ratio: number | null;
  /** The money that moved, when it is known. */
  total: number | null;
  is_income: boolean;
}

interface ActivityPage {
  items: ActivityItem[];
  total: number;
  page: number;
  page_size: number;
  /** Dividends, interest and gains across the whole filter, not just this page. */
  income_total: number;
}

function buildQS(filters: ActivityFilters): string {
  const p = new URLSearchParams();
  if (filters.date_from) p.set("date_from", filters.date_from);
  if (filters.date_to) p.set("date_to", filters.date_to);
  if (filters.account_id) p.set("account_id", String(filters.account_id));
  if (filters.kind) p.set("kind", filters.kind);
  if (filters.search) p.set("search", filters.search);
  p.set("page", String(filters.page ?? 1));
  p.set("page_size", String(filters.page_size ?? 20));
  return `?${p.toString()}`;
}

export function useInvestmentActivity(filters: ActivityFilters) {
  return useQuery<ActivityPage>({
    queryKey: ["investment-activity", filters],
    queryFn: () => api.get<ActivityPage>(`/investments/activity${buildQS(filters)}`),
    // Hold the rows already shown while a new page or filter loads.
    placeholderData: (prev) => prev,
  });
}

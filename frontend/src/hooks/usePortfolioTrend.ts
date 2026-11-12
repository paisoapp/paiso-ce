import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface TrendPoint {
  date: string;
  value: number;
}

interface TickerPoint {
  date: string;
  close: number;
}

export interface TrendSession {
  date: string | null;       // ET session date shown (YYYY-MM-DD)
  is_current: boolean;       // is this the current ET date
  market_open: boolean;      // is the US market open right now
}

interface PortfolioTrend {
  series: TrendPoint[];
  by_ticker?: Record<string, TickerPoint[]>;
  session?: TrendSession;
}

export interface TrendRange {
  from: string;
  to: string;
}

export type TrendInterval = "1d" | "1h" | "5m" | "1m";

export function usePortfolioTrend(
  range: TrendRange | null = null,
  accountId?: number,
  securityIds?: number[],
  breakdown?: boolean,
  interval: TrendInterval = "1d",
  /** Restrict to these accounts (a tab's own); undefined = every account. */
  accountIds?: number[],
  /** Plan tabs: sum each account's own value series, and return these
   *  accounts' series as overlays keyed "acct:<id>". */
  plans?: { overlayAccounts: number[] },
) {
  const from = range?.from ?? "1970-01-01";
  const to = range?.to ?? new Date().toISOString().split("T")[0];

  const params = new URLSearchParams({ date_from: from, date_to: to });
  if (accountId) params.set("account_id", String(accountId));
  if (securityIds && securityIds.length > 0) params.set("security_ids", securityIds.join(","));
  if (accountIds) params.set("account_ids", accountIds.join(",") || "-1");
  if (plans) {
    params.set("plans", "true");
    if (plans.overlayAccounts.length) params.set("overlay_accounts", plans.overlayAccounts.join(","));
  }
  if (breakdown) params.set("breakdown", "true");
  if (interval !== "1d") params.set("interval", interval);

  // Intraday queries go stale in 1 min; daily queries in 5 min
  const staleTime = interval === "1d" ? 5 * 60 * 1000 : 60 * 1000;

  return useQuery<PortfolioTrend>({
    queryKey: [
      "portfolio-trend",
      from,
      to,
      accountId ?? null,
      securityIds?.join(",") ?? null,
      breakdown ?? false,
      interval,
      accountIds?.join(",") ?? null,
      plans ? `plans:${plans.overlayAccounts.join(",")}` : null,
    ],
    queryFn: () => api.get<PortfolioTrend>(`/portfolio/trend?${params.toString()}`),
    staleTime,
  });
}

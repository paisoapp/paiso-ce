import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface AnalystConsensus {
  rating: string | null;
  score: number | null;
  analyst_count: number | null;
  target_mean: number | null;
  target_high: number | null;
  target_low: number | null;
}

interface TickerNewsItem {
  title: string | null;
  publisher: string | null;
  published_at: string | null;
  url: string | null;
}

export interface TickerFundamentals {
  market_cap: number | null;
  sector: string | null;
  industry: string | null;
  dividend_yield: number | null;
  eps_ttm: number | null;
  forward_pe: number | null;
  price_to_book: number | null;
  debt_to_equity: number | null;
  return_on_equity: number | null;
  revenue: number | null;
  gross_profit: number | null;
  free_cash_flow: number | null;
  beta: number | null;
  avg_volume: number | null;
  short_ratio: number | null;
}

interface TickerDetail {
  symbol: string;
  name: string | null;
  price: number | null;
  day_change: number | null;
  day_change_pct: number | null;
  day_high: number | null;
  day_low: number | null;
  week52_high: number | null;
  week52_low: number | null;
  fundamentals: TickerFundamentals;
  analyst: AnalystConsensus;
  news: TickerNewsItem[];
}

export function useTickerDetail(symbol: string | null | undefined, enabled: boolean) {
  return useQuery<TickerDetail>({
    queryKey: ["ticker-detail", symbol],
    queryFn: () => api.get<TickerDetail>(`/market/detail/${encodeURIComponent(symbol!)}`),
    enabled: enabled && !!symbol,
    staleTime: 10 * 60 * 1000,
  });
}

interface MarketHistoryPoint {
  date: string;
  close: number;
  volume: number;
}

export type MarketHistoryRange = "90d" | "ytd" | "12m" | "prior_year";

/** Daily close history for an arbitrary ticker (need not be held in the
 *  portfolio) — backs the standalone ticker-lookup trend chart. */
export function useMarketHistory(
  symbol: string | null | undefined,
  range: MarketHistoryRange,
  enabled: boolean,
) {
  return useQuery<MarketHistoryPoint[]>({
    queryKey: ["market-history", symbol, range],
    queryFn: () => api.get<MarketHistoryPoint[]>(`/market/history/${encodeURIComponent(symbol!)}?range=${range}`),
    enabled: enabled && !!symbol,
    staleTime: 5 * 60 * 1000,
  });
}

export interface TickerSearchResult {
  symbol: string;
  name: string;
  exchange: string | null;
  type: string | null;
}

/** Ticker/company-name typeahead — lets a user find a symbol by typing a
 *  company name instead of already knowing the ticker. Caller is expected to
 *  debounce `query` themselves before passing it in. */
export function useTickerSearch(query: string, enabled: boolean) {
  const q = query.trim();
  return useQuery<TickerSearchResult[]>({
    queryKey: ["ticker-search", q],
    queryFn: () => api.get<TickerSearchResult[]>(`/market/search?q=${encodeURIComponent(q)}`),
    enabled: enabled && q.length > 0,
    staleTime: 5 * 60 * 1000,
  });
}

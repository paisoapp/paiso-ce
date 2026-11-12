import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface Holding {
  id: number;
  account_id: number;
  account_name: string | null;
  security_id: number;
  ticker: string | null;
  name: string;
  type: string;
  expense_ratio: number | null;
  shares: number;
  /** null when nobody recorded what the position cost. Not the same as 0:
   *  rendering an unknown basis as zero reports the whole market value as gain. */
  cost_basis_total: number | null;
  acquired_at: string | null;
  lot_method: string;
  price: number;
  current_value: number;
  day_change: number;       // per-share absolute price change
  day_gain: number;         // total position $ change (shares × day_change)
  day_change_pct: number;
  /**
   * ISO date of the session `day_change` covers. When the market is closed this
   * is the last completed session rather than today, so the UI can avoid
   * labelling Friday's move as "today". Null when the change came from the
   * quote rather than stored closes.
   */
  day_change_session: string | null;
  day_high: number | null;
  day_low: number | null;
  week52_high: number | null;
  week52_low: number | null;
  /** null when the basis is unknown, for the same reason. */
  total_gain: number | null;
  total_gain_pct: number | null;
  exclude_from_net_worth: boolean;
  is_favorited: boolean;
  has_trades: boolean;
  is_balance_account?: boolean;
  _optPlanId?: number;
  /** What the row is. Holdings are positions the user or their institution
   *  holds; the rest come from the same book the Dashboard totals, so the rows
   *  not excluded from net worth add up to its investment value. */
  kind?: HoldingRowKind;
  row_key?: string;
  /** live | close | institution | manual; null = nothing could price it. */
  price_source?: string | null;
  price_as_of?: string | null;
  /** How the row's account is valued: positions, balance. */
  value_source?: string | null;
  /** The holding's own flag (exclude_from_net_worth also covers its account's). */
  holding_excluded?: boolean;
  /** The account is excluded from net worth (a row valued as one number). */
  account_excluded?: boolean;
}

export type HoldingRowKind =
  | "holding"
  | "balance"
  | "other_funds";

export type TradeAction =
  | "buy"
  | "sell"
  | "dividend"
  | "reinvest"
  | "interest"
  | "capgain"
  | "split"
  // Only an institution sends these three; they cannot be typed in.
  | "fee"
  | "transfer_in"
  | "transfer_out";

export const INCOME_ACTIONS: TradeAction[] = ["dividend", "reinvest", "interest", "capgain"];

interface Trade {
  id: number;
  holding_id: number;
  trade_date: string;
  action: TradeAction;
  shares: number;
  price_per_share: number | null;
  amount: number | null;
  split_ratio: number | null;
  is_qualified: boolean | null;
  notes: string | null;
}

const QK = "holdings";

export function useHoldings(opts?: { refetchInterval?: number | false }) {
  return useQuery<Holding[]>({
    queryKey: [QK],
    queryFn: () => api.get<Holding[]>("/holdings"),
    // Keep showing the current rows while a background refetch is in flight, so
    // auto-refresh swaps values in silently instead of flashing a loading state.
    placeholderData: keepPreviousData,
    refetchInterval: opts?.refetchInterval ?? false,
    refetchIntervalInBackground: false,
  });
}

export function useCreateHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      account_id: number;
      security: { ticker?: string; name: string; type?: string; expense_ratio?: number };
      shares?: number;
      /** null clears it — see update_holding: unknown is not zero. */
      cost_basis_total?: number | null;
      acquired_at?: string;
      lot_method?: string;
    }) => api.post<Holding>("/holdings", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useUpdateHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; shares?: number; cost_basis_total?: number | null; acquired_at?: string; exclude_from_net_worth?: boolean; is_favorited?: boolean; expense_ratio?: number }) =>
      api.patch<Holding>(`/holdings/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      // Totals on the Dashboard and Overview move with shares and exclusions.
      qc.invalidateQueries({ queryKey: ["portfolio"] });
    },
  });
}

export function useDeleteHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/holdings/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: [QK] }),
  });
}

export function useRefreshMarket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ refreshed: number }>("/market/refresh"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio-trend"] });
    },
  });
}

// Silent re-read of holdings (and the trend) from the server. Prices are kept
// warm server-side by the refresh_all_market_data worker, so this just pulls
// the latest cached values — no blocking Yahoo fetch, no loading state.
export function useRefetchHoldings() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [QK] });
    qc.invalidateQueries({ queryKey: ["portfolio-trend"] });
  };
}

// ── Trade history hooks ───────────────────────────────────────────────────────

export function useTrades(holdingId: number | null) {
  return useQuery<Trade[]>({
    queryKey: ["trades", holdingId],
    queryFn: () => api.get<Trade[]>(`/holdings/${holdingId}/trades`),
    enabled: holdingId != null,
  });
}

export function useCreateTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ holdingId, ...body }: {
      holdingId: number;
      trade_date: string;
      action: TradeAction;
      shares?: number;
      price_per_share?: number;
      amount?: number;
      split_ratio?: number;
      is_qualified?: boolean;
      notes?: string;
    }) => api.post<Trade>(`/holdings/${holdingId}/trades`, body),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["trades", vars.holdingId] });
      qc.invalidateQueries({ queryKey: ["investment-activity"] });
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio-income"] });
    },
  });
}

// ── Dividend suggestions (Investment Income feature) ─────────────────────────

interface DividendSuggestion {
  ex_date: string;
  amount_per_share: number;
  shares_held: number;
  total: number;
  already_recorded: boolean;
  price_hint: number | null; // unadjusted close on ex_date, for DRIP share estimate
}

interface DividendSuggestionsResponse {
  suggestions: DividendSuggestion[];
  reason?: string; // "no_trade_history" when shares-held can't be derived
}

export function useDividendSuggestions(holdingId: number | null, enabled: boolean) {
  return useQuery<DividendSuggestionsResponse>({
    queryKey: ["dividend-suggestions", holdingId],
    queryFn: () => api.get<DividendSuggestionsResponse>(`/holdings/${holdingId}/dividend-suggestions`),
    enabled: enabled && holdingId != null,
  });
}

interface RefreshDividendsResult {
  refreshed: boolean;
  reason?: string;        // "recently_synced" when within the cooldown
  synced_at: string;      // ISO timestamp of the last sync
  rows: number;
}

export function useRefreshDividends() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (holdingId: number) =>
      api.post<RefreshDividendsResult>(`/holdings/${holdingId}/refresh-dividends`),
    onSuccess: (_data, holdingId) => {
      qc.invalidateQueries({ queryKey: ["dividend-suggestions", holdingId] });
    },
  });
}

interface SuggestionConfirmation {
  ex_date: string;
  action: "dividend" | "reinvest";
  amount: number;
  shares?: number;
  price_per_share?: number;
  is_qualified?: boolean;
}

export function useConfirmDividends() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ holdingId, confirmations }: { holdingId: number; confirmations: SuggestionConfirmation[] }) =>
      api.post(`/holdings/${holdingId}/dividend-suggestions/confirm`, { confirmations }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["dividend-suggestions", vars.holdingId] });
      qc.invalidateQueries({ queryKey: ["trades", vars.holdingId] });
      qc.invalidateQueries({ queryKey: ["investment-activity"] });
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio-income"] });
    },
  });
}

// ── Portfolio income summary ──────────────────────────────────────────────────

interface IncomeSummary {
  year: number;
  year_total: number;
  ytd_total: number | null;
  by_month: number[];
  by_holding: { holding_id: number; label: string; total: number }[];
  projected_annual: number;
}

export function useIncomeSummary(enabled: boolean, year?: number) {
  return useQuery<IncomeSummary>({
    queryKey: ["portfolio-income", year ?? "current"],
    queryFn: () => api.get<IncomeSummary>(`/portfolio/income${year ? `?year=${year}` : ""}`),
    enabled,
    staleTime: 60_000,
  });
}

export function useDeleteTrade() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ holdingId, tradeId }: { holdingId: number; tradeId: number }) =>
      api.delete(`/holdings/${holdingId}/trades/${tradeId}`),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["trades", vars.holdingId] });
      qc.invalidateQueries({ queryKey: ["investment-activity"] });
      qc.invalidateQueries({ queryKey: [QK] });
      qc.invalidateQueries({ queryKey: ["portfolio-income"] });
    },
  });
}

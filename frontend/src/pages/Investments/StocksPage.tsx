import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { createPortal } from "react-dom";
import { Popover } from "@/pages/Budgeting/budget/Popover";
import { Plus, RefreshCw, Search, X, AlertTriangle, Eye, EyeOff, Star, History, Trash2, ChevronLeft, ChevronDown, TrendingUp, Info, SlidersHorizontal, ExternalLink, Maximize2 } from "@/lib/icons";
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { TooltipProps } from "recharts";
import { Button } from "@/components/ui/button";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { DateRangePicker, type DateRange, defaultRange } from "@/components/ui/DateRangePicker";
import { useDailySectionRange } from "@/hooks/useSectionDateRange";
import { DailyRangeHint } from "@/components/ui/RangeEmptyHint";
import { useDragZoom } from "@/hooks/useDragZoom";
import type { DateRangeSection } from "@/store/uiPrefs";
import { dateTickCount, evenTicks, niceMoneyAxis, niceScale } from "@/lib/chartTicks";
import { formatAxisDate, formatDate, formatDateTime, spanInDays } from "@/lib/dates";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { useAccounts, useCreateAccount, useUpdateAccount } from "@/hooks/useAccounts";
import { useIsMobile } from "@/hooks/useMediaQuery";
import {
  useCreateHolding, useDeleteHolding, useHoldings, useRefetchHoldings, useRefreshMarket, useUpdateHolding,
  useTrades, useCreateTrade, useDeleteTrade, useDividendSuggestions, useConfirmDividends, useIncomeSummary,
  useRefreshDividends,
} from "@/hooks/useHoldings";
import {
  useTickerDetail, useMarketHistory, useTickerSearch,
  type TickerFundamentals, type MarketHistoryRange, type TickerSearchResult,
} from "@/hooks/useTickerDetail";
import { useDebounce } from "@/hooks/useDebounce";
import type { Holding, TradeAction } from "@/hooks/useHoldings";
import { INCOME_ACTIONS } from "@/hooks/useHoldings";
// One row of the unified table: a Holding, or a row that stands for one.
type RowItem = Holding;

/** A row that stands for something other than a Holding — an account's
 *  "Other funds" value, an account balance. None has a day change, a
 *  trading range or a cost basis, so those cells render "—" rather than a
 *  fabricated zero. A holding with no market ticker is the same: its price is
 *  the institution's, with no session or range behind it. */
const isSynthetic = (h: RowItem) =>
  (h.kind != null && h.kind !== "holding") || (h.kind === "holding" && !h.ticker);

const KIND_BADGE: Partial<Record<string, { label: string; cls: string; title: string }>> = {
  other_funds: { label: "OTHER FUNDS", cls: "bg-muted text-muted-foreground", title: "Funds with no ticker in this account, at the value you entered" },
};

/** "Last close · Oct 14" and the like, for a row whose price is not a live
 *  market quote. A synced fund with no public ticker carries the price its
 *  institution reported, without a note. */
function priceSourceNote(h: RowItem): string | null {
  const day = h.price_as_of
    ? new Date(`${h.price_as_of}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : null;
  const at = day ? ` · ${day}` : "";
  switch (h.price_source) {
    case "manual": return `Price you entered${at}`;
    case "close": return `Last close${at}`;
    case null: return h.kind === "holding" ? "No price yet" : null;
    default: return null;
  }
}
import { usePortfolioTrend, type TrendInterval, type TrendRange } from "@/hooks/usePortfolioTrend";
import { FeatureTip } from "@/components/onboarding/FeatureTip";
import { formatCurrency, formatCurrencyFull, formatCompact, cn, matchesSearch } from "@/lib/utils";
import { EARLIEST_DATE, todayIso } from "@/lib/validation";

// ── Info tooltip ─────────────────────────────────────────────────────────────

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative group inline-flex items-center">
      <Info size={12} className="text-muted-foreground/60 hover:text-muted-foreground cursor-default transition-colors" />
      {/* display:none (not opacity-0) when idle — an always-laid-out w-56 tooltip
          centered on an icon near the right edge spills past the viewport and
          creates horizontal page overflow / blank space on mobile. [mobile overflow] */}
      <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 w-56 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-md hidden group-hover:block z-50 leading-relaxed">
        {text}
      </span>
    </span>
  );
}

/** Instant hover tooltip for elements sitting inside an `overflow-hidden`
 *  ancestor (e.g. table cells) — a plain CSS group-hover tooltip would get
 *  clipped there, so this portals to `document.body` and positions itself
 *  from the trigger's bounding rect instead. Shows immediately on hover,
 *  unlike the native `title` attribute's browser-controlled delay. */
function HoverHint({ text, children }: { text: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const TOOLTIP_WIDTH = 260;
    setPos({
      top: rect.bottom + 6,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 8)),
    });
  }

  return (
    <span ref={triggerRef} className="inline-flex" onMouseEnter={show} onMouseLeave={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <div
          className="fixed z-[100] w-64 max-w-[calc(100vw-1.5rem)] rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-md leading-relaxed pointer-events-none"
          style={{ top: pos.top, left: pos.left }}
        >
          {text}
        </div>,
        document.body,
      )}
    </span>
  );
}

/** "Netflix, Inc (NFLX)" — falls back to whichever of name/ticker is present
 *  when the other is missing, and avoids a redundant "VOO (VOO)" when the
 *  underlying data's `name` field is just the ticker again. */
function fullTickerLabel(ticker: string | null | undefined, name: string | undefined): string {
  const t = (ticker ?? "").trim();
  const n = (name ?? "").trim();
  if (!n || !t || n.toUpperCase() === t.toUpperCase()) return t || n || "Holding";
  return `${n} (${t})`;
}

/** Side-drawer header for a holding: full company name (ticker). */
function HoldingDrawerTitle({ ticker, name, suffix }: {
  ticker: string | null | undefined; name: string | undefined; suffix?: string;
}) {
  // The holding's own `name` field is sometimes just the ticker again
  // (depends on how it was imported/added) — fall back to market data's
  // company name in that case, same source the ticker deep-dive view uses.
  const needsRealName = !name || name.trim().toUpperCase() === (ticker ?? "").trim().toUpperCase();
  const { data: detail } = useTickerDetail(ticker ?? undefined, needsRealName && !!ticker);
  const displayName = needsRealName ? (detail?.name ?? name) : name;

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="truncate">{fullTickerLabel(ticker, displayName)}{suffix ?? ""}</span>
    </div>
  );
}

const OVERLAY_DISABLED_HINT = "Overlay comparison needs a longer date range (not available for Today/This week/Last week)";

/** Ticker-column overlay toggle — lets a holding's price be charted alongside
 *  the portfolio trend. Disabled (with an instant hint, not the delayed
 *  native tooltip) when the chart is showing intraday bars, since there's no
 *  per-ticker intraday series to overlay. */
export function OverlayToggleButton({ ticker, isActive, overlayColor, isChartIntraday, onToggle }: {
  ticker: string;
  isActive: boolean;
  overlayColor: string | undefined;
  isChartIntraday: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  const button = (
    <button
      type="button"
      disabled={isChartIntraday}
      onClick={onToggle}
      title={isChartIntraday ? undefined : isActive ? `Remove ${ticker} overlay` : `Overlay ${ticker} on chart`}
      className={cn(
        "p-0.5 rounded transition-colors shrink-0",
        isChartIntraday
          ? "text-muted-foreground/15 cursor-not-allowed"
          : isActive ? "text-white" : "text-muted-foreground/30 hover:text-muted-foreground",
      )}
      style={isActive && !isChartIntraday ? { background: overlayColor, borderRadius: 3 } : undefined}
    >
      <TrendingUp size={11} />
    </button>
  );

  if (!isChartIntraday) return button;
  return <HoverHint text={OVERLAY_DISABLED_HINT}>{button}</HoverHint>;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function pad(n: number) { return String(n).padStart(2, "0"); }
function fmt(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function today() { return fmt(new Date()); }

/**
 * Longest run of missing calendar days we'll bridge with a carry-forward value.
 * A weekend plus an adjoining holiday is 3 days (4 for something like a Friday
 * holiday before a long weekend). Anything longer is a data gap — a symbol that
 * stopped refreshing, say — and drawing a confident flat line across it would
 * invent a fact rather than show one.
 */
const MAX_CARRY_FORWARD_DAYS = 4;

/**
 * Fill non-trading days (weekends, market holidays) with the previous close.
 *
 * The daily series only contains sessions, and the axis is categorical, so a
 * weekend used to occupy exactly as much width as a single trading day: the
 * axis jumped 7/3 → 7/6 and the line sloped through it as though the move
 * happened continuously. Carrying the last close forward puts the calendar back
 * on the axis and draws the closed days flat, which is what actually happened.
 * [issue 4]
 *
 * Presentation only — the caller's data is untouched, and gain/loss figures are
 * computed from the original series.
 */
function fillNonTradingDays<T extends { date: string; value: number }>(points: T[]): T[] {
  if (points.length < 2) return points;

  const out: T[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    out.push(pt);

    const next = points[i + 1];
    if (!next) break;
    // Intraday timestamps are handled by their own tick logic — leave them be.
    if (pt.date.includes("T") || next.date.includes("T")) continue;

    const cursor = new Date(pt.date + "T00:00:00");
    const end = new Date(next.date + "T00:00:00");
    const gapDays = Math.round((end.getTime() - cursor.getTime()) / 86_400_000) - 1;
    if (gapDays < 1 || gapDays > MAX_CARRY_FORWARD_DAYS) continue;

    for (let d = 0; d < gapDays; d++) {
      cursor.setDate(cursor.getDate() + 1);
      const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
      // Carry the close forward: the market was shut, so the value didn't move.
      out.push({ ...pt, date: iso });
    }
  }
  return out;
}

/** "2026-06-20" → "Fri, Jun 20" for the market-closed session label. */
function fmtSessionDate(isoDate: string): string {
  return new Date(isoDate + "T00:00:00").toLocaleDateString([], {
    weekday: "short", month: "short", day: "numeric",
  });
}

/**
 * Suffix for a day-change figure: "today" during/after the current session,
 * otherwise the session the move actually belongs to. On a Saturday the number
 * is Friday's move, and calling that "today" reads as a bug. [issue 5]
 */
export function sessionSuffix(session: string | null | undefined): string {
  if (!session) return "today";
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return session === iso ? "today" : fmtSessionDate(session);
}

// ── Market-hours detection ────────────────────────────────────────────────────

/** Returns true if the current moment falls within NYSE regular trading hours
 *  (Mon–Fri, 9:30 AM – 4:00 PM US Eastern, excluding holidays is not checked). */
function isMarketOpen(): boolean {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const day = et.getDay(); // 0 = Sun, 6 = Sat
  if (day === 0 || day === 6) return false;
  const totalMin = et.getHours() * 60 + et.getMinutes();
  return totalMin >= 9 * 60 + 30 && totalMin < 16 * 60;
}

// ── Overlay palette ───────────────────────────────────────────────────────────

export const OVERLAY_COLORS = [
  "#f59e0b", "#8b5cf6", "#f97316", "#06b6d4", "#ec4899",
  "#84cc16", "#14b8a6", "#a855f7", "#eab308", "#0ea5e9",
];

// ── Portfolio Trend Chart ─────────────────────────────────────────────────────

interface TrendChartProps {
  accountId?: number;
  securityIds?: number[];
  /** The accounts the chart covers (this tab's); undefined = all. */
  accountIds?: number[];
  /** Plan tabs: the line is each plan's value summed, daily, and an overlay
   *  key "acct:<id>" is that plan's own line. */
  plansMode?: boolean;
  /** Display names for overlay keys that are not tickers ("acct:12"). */
  overlayLabels?: Record<string, string>;
  title?: string;
  /** What the main line is called in the overlay legend. */
  seriesLabel?: string;
  availableTickers?: { ticker: string; name: string }[];
  overlayTickers: string[];
  onToggleOverlay: (ticker: string) => void;
  onClearOverlays: () => void;
  onIntradayChange?: (isIntraday: boolean) => void;
  /** Today's change from the holdings API — `(price - previous close) x shares`
   *  summed over the same holdings the chart is drawing.
   *
   *  The chart's own series cannot produce this number. Its first point is the
   *  first bar *of the session*, so a chart-derived change silently drops the
   *  overnight gap, and on a closed day it measures from the last stored bar
   *  rather than the official close. The API value comes from `_session_delta`,
   *  which steps back to the previous completed session when the market is
   *  shut — so it stays truthful on evenings, weekends and holidays instead of
   *  collapsing to $0.00. Used for the "today's change" headline; the longer
   *  ranges still read "period change" off the series. */
  dayGain?: number;
  /** Market value of those same holdings, so the headline's value and change
   *  come from one source rather than mixing a stale bar with a live quote. */
  dayValue?: number;
  /** Which remembered date range it follows. The dashboard widget shares the
   *  dashboard's; on Investments it is the section's. */
  rangeSection?: DateRangeSection;
  className?: string;
}

/** Derive the appropriate data granularity from how wide the date window is. */
function intervalForRange(range: DateRange | null): TrendInterval {
  if (!range) return "1d";
  const from = new Date(range.from + "T00:00:00");
  const to   = new Date(range.to   + "T00:00:00");
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (days === 0) return "1m";   // Today → 1-minute bars
  if (days <= 7)  return "1h";   // This week / Last week → hourly bars
  return "1d";                   // Everything else → daily
}

export function PortfolioTrendChart({ accountId, securityIds, accountIds, plansMode = false, overlayLabels, title = "Performance", seriesLabel = "Portfolio", availableTickers = [], overlayTickers, onToggleOverlay, onClearOverlays, onIntradayChange, dayGain, dayValue, rangeSection = "investments", className }: TrendChartProps) {
  const overlayName = (key: string) => overlayLabels?.[key] ?? key;
  // The investments date range is a remembered preference: it survives tab
  // switches, sessions and devices (localStorage + backend). [ui prefs]
  // On a plans tab (daily values, its own range) a pick under a week selects
  // the last 30 days, with a hint. The dashboard's range is shared
  // with every other widget, so the plans widget there leaves it alone.
  const { dateRange, setDateRange, replaced } = useDailySectionRange(
    rangeSection, plansMode && rangeSection.startsWith("investments_"),
  );
  // Drag across the chart to zoom into those dates.
  const zoom = useDragZoom({ range: dateRange, setRange: setDateRange });
  // Which headline figure is the big one. Remembered like the date range: a
  // user who reads this card for the portfolio's size rather than for today's
  // move should not have to re-pick that on every visit.
  const headlineFocus = useUiPrefsStore((s) => s.investmentsHeadlineFocus);
  const setHeadlineFocus = useUiPrefsStore((s) => s.setInvestmentsHeadlineFocus);
  const [viewMode, setViewMode] = useState<"dollar" | "pct">("dollar");
  const isMobile = useIsMobile();

  // Interval is fully derived — no separate state needed. Plan values are
  // daily (a plan's institution balance or entered value has no intraday).
  const interval = plansMode ? "1d" : intervalForRange(dateRange);
  const isIntraday = interval !== "1d";

  // Notify parent of intraday state; clear overlays when entering intraday
  useEffect(() => {
    onIntradayChange?.(isIntraday);
    if (isIntraday) onClearOverlays();
  }, [isIntraday]); // eslint-disable-line react-hooks/exhaustive-deps

  const trendRange: TrendRange | null = dateRange
    ? { from: dateRange.from, to: dateRange.to }
    : null;

  const hasOverlays = overlayTickers.length > 0;
  const { data, isLoading } = usePortfolioTrend(
    trendRange, accountId, securityIds, hasOverlays, interval, accountIds,
    plansMode
      ? { overlayAccounts: overlayTickers.filter((k) => k.startsWith("acct:")).map((k) => Number(k.slice(5))) }
      : undefined,
  );
  const series = data?.series ?? [];
  const hasData = series.length > 0;
  const session = data?.session;

  // Safety net: if an intraday view loads with no data (cold start, or after a
  // fresh deploy before the background worker's first run), kick a one-time
  // refresh to populate it. Guarded so it fires at most once per mount and never
  // loops when the market is genuinely closed with no session to show.
  const trendRefresh = useRefreshMarket();
  const autoFetchedRef = useRef(false);
  useEffect(() => {
    if (isIntraday && !isLoading && series.length === 0 && !autoFetchedRef.current) {
      autoFetchedRef.current = true;
      trendRefresh.mutate();
    }
  }, [isIntraday, isLoading, series.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstVal = series[0]?.value ?? 0;
  const lastVal  = series[series.length - 1]?.value ?? 0;
  const gain     = lastVal - firstVal;
  const gainPct  = firstVal > 0 ? (gain / firstVal) * 100 : 0;
  const isPositive = gain >= 0;
  // Drives the empty-state copy: the Refresh button it used to name is a paid
  // control, so the instruction only makes sense for users who can see one.

  // The "today" headline comes from the holdings API rather than the series —
  // see `dayGain` on TrendChartProps for why the series cannot answer it. Only
  // the 1-minute view is a single session; every longer range is a genuine
  // period change and stays series-derived. Falls back to the series while the
  // holdings query is still in flight.
  const useDayFigures = interval === "1m" && dayGain != null;
  const headGain    = useDayFigures ? dayGain : gain;
  const headValue   = useDayFigures && dayValue != null ? dayValue : lastVal;
  // Percent against what the holdings were worth *before* today's move, so it
  // matches the dollar figure beside it instead of the series' own baseline.
  const headBasis   = headValue - headGain;
  const headGainPct = useDayFigures
    ? (headBasis > 0 ? (headGain / headBasis) * 100 : 0)
    : gainPct;
  const headPositive = headGain >= 0;
  const focusValue = headlineFocus === "value";
  // A start figure only means something when there is one: a portfolio whose
  // whole value arrived inside the window has nothing to have grown from.
  const showStartValue = headBasis > 0;
  const isFiltered = accountId != null || (securityIds && securityIds.length > 0);
  // Name the filter rather than just flagging one: a page opened from an
  // account's row on the overview starts filtered to that account.
  const { data: allAccounts = [] } = useAccounts();
  const filteredAccountName = accountId != null
    ? allAccounts.find((a) => a.id === accountId)?.display_name ?? null
    : null;

  // Percent-change series: each value normalised to % change from the first data point
  const pctSeries = useMemo(() => {
    if (!hasData || firstVal === 0) return [];
    return series.map((pt) => ({ date: pt.date, value: ((pt.value - firstVal) / firstVal) * 100 }));
  }, [series, hasData, firstVal]);

  // What the main AreaChart actually renders. Daily views get closed days filled
  // in so the axis reads as a calendar; intraday views are already continuous
  // within a session. Gain/loss above is computed from the raw series, so the
  // filler points are purely presentational.
  const displaySeries = useMemo(() => {
    const base = !hasOverlays && viewMode === "pct" ? pctSeries : series;
    return isIntraday ? base : fillNonTradingDays(base);
  }, [hasOverlays, viewMode, pctSeries, series, isIntraday]);

  // Does the intraday window span more than one calendar day? (This week / Last
  // week cover several trading sessions; Today is a single session.)
  const isMultiDayIntraday = useMemo(() => {
    if (!isIntraday) return false;
    const days = new Set<string>();
    for (const pt of displaySeries) {
      if (pt.date.includes("T")) days.add(pt.date.slice(0, 10));
      if (days.size > 1) return true;
    }
    return false;
  }, [isIntraday, displaySeries]);

  // Uniform X-axis ticks. Recharts' default `preserveStartEnd` spaces ticks by
  // data index — with market-hours gaps that yields ragged labels (8:45 / 9:01)
  // and a stray end tick. Instead we hand it an explicit, evenly-cadenced set:
  //   • single session  → the first bar in each fixed clock bucket (15/30/60 min,
  //     chosen by span) so labels land on tidy :00/:15/:30 marks;
  //   • multiple sessions → the first bar of each calendar day (a per-session
  //     time-of-day bucket would collapse every day onto the same ~7 buckets and
  //     leave the rest of the chart unlabeled). [issue 4]
  const intradayTicks = useMemo(() => {
    if (!isIntraday) return undefined;
    const pts = displaySeries.filter((p) => p.date.includes("T"));
    if (pts.length === 0) return undefined;

    if (isMultiDayIntraday) {
      const seenDay = new Set<string>();
      const ticks: string[] = [];
      for (const pt of pts) {
        const day = pt.date.slice(0, 10);
        if (!seenDay.has(day)) {
          seenDay.add(day);
          ticks.push(pt.date);
        }
      }
      return ticks;
    }

    const first = new Date(pts[0].date);
    const last = new Date(pts[pts.length - 1].date);
    const spanMin = (last.getTime() - first.getTime()) / 60_000;
    // A full session at 30-minute cadence is ~14 labels — fine on a desktop
    // axis, illegibly overlapped at 375px. Mobile always steps hourly.
    const stepMin = isMobile ? 60 : spanMin <= 210 ? 15 : spanMin <= 420 ? 30 : 60;

    const bucketTicks = (onlyWholeHours: boolean) => {
      const seen = new Set<number>();
      const out: string[] = [];
      for (const pt of pts) {
        const d = new Date(pt.date);
        if (onlyWholeHours && d.getMinutes() !== 0) continue;
        const bucket = Math.floor((d.getHours() * 60 + d.getMinutes()) / stepMin);
        if (!seen.has(bucket)) {
          seen.add(bucket);
          out.push(pt.date);
        }
      }
      return out;
    };

    if (isMobile) {
      // Anchoring to whole hours keeps the cadence even. Taking the first bar in
      // each bucket instead would label the 9:30 open and then 10:00 barely a
      // few pixels later, which is the collision we're trying to avoid. Fall
      // back if the bars don't sit on the hour.
      const wholeHours = bucketTicks(true);
      if (wholeHours.length >= 2) return wholeHours;
    }
    return bucketTicks(false);
  }, [isIntraday, isMultiDayIntraday, displaySeries, isMobile]);

  // Daily views get the same treatment for the same reason: `preserveStartEnd`
  // drops whichever labels would collide and then forces the last one back in,
  // leaving an uneven run at the right-hand end (…9/19, 9/21, 9/23). An explicit
  // evenly-cadenced list keeps every gap identical.
  const dailyTicks = useMemo(
    () => (isIntraday ? undefined : evenTicks(displaySeries, "date", dateTickCount(isMobile))),
    [isIntraday, displaySeries, isMobile],
  );

  // Pre-compute pct Y-domain so the gradient stop position matches the axis exactly
  // Round, evenly spaced value ticks: see niceScale in lib/chartTicks.
  const pctScale = useMemo(() => niceScale(pctSeries.map((p) => p.value)), [pctSeries]);
  const pctDomain: [number, number] = pctScale?.domain ?? [-1, 1];
  const pctDigits = pctScale && pctScale.step < 1 ? (pctScale.step < 0.1 ? 2 : 1) : 0;
  const dollarAxis = useMemo(() => niceMoneyAxis(series.map((p) => p.value)), [series]);
  const daySpan = spanInDays(displaySeries[0]?.date, displaySeries[displaySeries.length - 1]?.date);

  // Where y=0 sits as a fraction from the TOP of the SVG area (SVG y-axis is inverted)
  const zeroStopPct = useMemo(() => {
    const [dMin, dMax] = pctDomain;
    if (dMax === dMin) return "50%";
    const frac = Math.max(0, Math.min(1, (dMax - 0) / (dMax - dMin)));
    return `${(frac * 100).toFixed(2)}%`;
  }, [pctDomain]);

  // Tooltip label formatter — intraday points carry a "T" in their ISO string.
  // Intraday tooltips show date + time so a hovered point is unambiguous even
  // across multiple sessions.
  const fmtDate = (d: string) => (d.includes("T") ? formatDateTime(d) : formatDate(d));

  // X-axis tick formatter — a single session shows clock times; multiple sessions
  // show the date (one tick per day), so labels never repeat the same time.
  const fmtAxis = (d: string) => {
    if (d.includes("T")) {
      if (isMultiDayIntraday) {
        return new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });
      }
      // "08:30 AM" is ~55px; seven of them don't fit a 375px chart even at an
      // hourly cadence. Drop the zero-padding and the :00 on whole hours.
      const t = new Date(d);
      if (isMobile) {
        return t.getMinutes() === 0
          ? t.toLocaleTimeString([], { hour: "numeric" })
          : t.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      }
      return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return formatAxisDate(d, daySpan);
  };

  // % change overlay mode
  const chartData = useMemo(() => {
    if (!hasData || !hasOverlays) return series;

    const base = series[0]?.value ?? 0;
    const byDate: Record<string, Record<string, number>> = {};
    series.forEach((pt) => {
      byDate[pt.date] = { portfolio_pct: base > 0 ? ((pt.value - base) / base) * 100 : 0 };
    });
    overlayTickers.forEach((ticker) => {
      const pts = data?.by_ticker?.[ticker] ?? [];
      if (!pts.length) return;
      const firstClose = pts[0].close;
      pts.forEach(({ date, close }) => {
        if (!byDate[date]) byDate[date] = { portfolio_pct: 0 };
        byDate[date][`${ticker}_pct`] = firstClose > 0 ? ((close - firstClose) / firstClose) * 100 : 0;
      });
    });
    return Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date, ...vals }));
  }, [series, hasOverlays, overlayTickers, data?.by_ticker, hasData]);

  const overlayTicks = useMemo(
    () => evenTicks(chartData, "date", dateTickCount(isMobile)),
    [chartData, isMobile],
  );

  const tooltipStyle = {
    background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95,
  };

  // What each daily point moved by on its own day, for the tooltip. Read off
  // the raw series, so a weekend drawn as a carried-forward close is known to
  // be one rather than reported as a day on which nothing changed.
  const dailyMoves = useMemo(() => {
    const moves = new Map<string, { prev: number | null }>();
    if (isIntraday) return moves;
    series.forEach((pt, i) => moves.set(pt.date, { prev: i > 0 ? series[i - 1].value : null }));
    return moves;
  }, [series, isIntraday]);

  // Hovering a point says what the holdings were worth then, and how far that
  // is from where the line began. Both figures come from the line itself.
  //
  // In the Today view the change used to be measured from the headline's
  // baseline instead — the holdings API's "value before today's move" — so the
  // right-hand end would agree with the headline. But that baseline is built
  // per holding, from whichever session each one's price belongs to, and a
  // mutual fund's price is a session behind all day: its NAV only posts in the
  // evening. With one in the portfolio the two baselines differ, and every
  // point on the line was off by that difference, starting with a non-zero
  // "change" at the very first point, the previous close. The line already
  // opens on the previous close, so measuring from its own first point is the
  // same question answered from one source. [issue 242]
  const renderTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const raw = payload[0].value;
    if (typeof raw !== "number") return null;
    // In % mode the plotted number *is* the change; recover the dollar value
    // from the same baseline the series was normalised against.
    const value = viewMode === "pct" ? firstVal * (1 + raw / 100) : raw;
    const change = value - firstVal;
    const changePct = firstVal > 0 ? (change / firstVal) * 100 : 0;
    const signed = (amount: number, pct: number) =>
      `${amount >= 0 ? "+" : ""}${formatCurrency(amount)} (${amount >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
    const tone = (amount: number) => (amount >= 0 ? "text-success" : "text-destructive");

    // Daily ranges also get the point's own day, which is what scrubbing along
    // a month of closes is usually looking for. A date missing from the raw
    // series is a closed day the chart filled in.
    const move = isIntraday ? undefined : dailyMoves.get(String(label));
    const closedDay = !isIntraday && move === undefined;
    const dayChange = move?.prev != null ? value - move.prev : null;
    const sinceLabel = interval === "1m"
      ? "since previous close"
      : `since ${series[0] ? fmtAxis(series[0].date) : "start"}`;

    return (
      // Styled with the theme's own tokens, not the `tooltipStyle` object
      // below: `--card` holds bare HSL channels ("0 0% 100%"), so a plain
      // `hsl(var(--card))` is not a valid colour. Recharts' default wrapper hid
      // that for `contentStyle` consumers by painting its own background
      // underneath; custom content has nothing underneath, so the box came
      // out fully transparent over the line.
      <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-md">
        <p className="text-muted-foreground mb-1">{label ? fmtDate(String(label)) : ""}</p>
        <p className="font-medium tabular-nums">{formatCurrency(value)}</p>
        {closedDay && <p className="text-muted-foreground">Market closed</p>}
        {dayChange != null && move?.prev != null && (
          <p className="tabular-nums">
            <span className={tone(dayChange)}>{signed(dayChange, move.prev > 0 ? (dayChange / move.prev) * 100 : 0)}</span>
            <span className="text-muted-foreground"> that day</span>
          </p>
        )}
        <p className="tabular-nums">
          <span className={tone(change)}>{signed(change, changePct)}</span>
          <span className="text-muted-foreground"> {sinceLabel}</span>
        </p>
      </div>
    );
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <FeatureTip
              id="ticker-compare"
              title="Compare tickers on the chart"
              // Plan tabs compare plans, not tickers.
              enabled={!plansMode && availableTickers.length > 0}
              placement="bottom"
            >
              Toggle the overlay control on any holding to chart its price against
              your portfolio. It is a quick way to compare tickers head-to-head.
            </FeatureTip>
            {isFiltered && (
              <span title="The chart shows only what the table below is filtered to."
                className="text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full font-medium">
                {filteredAccountName ? `${filteredAccountName} only` : "Filtered"}
              </span>
            )}
            {hasOverlays && (
              <span className="text-xs bg-warning/10 text-warning px-2 py-0.5 rounded-full font-medium">% change</span>
            )}
          </div>
          {hasData && !hasOverlays && (
            <div className="flex items-baseline gap-2 mt-0.5 flex-wrap">
              {/* The two figures trade places on click: whichever the user
                  picked is the large one, the other stays beside it small.
                  The value reads start → end so a chosen range says what the
                  portfolio grew *from*, not just where it landed. */}
              <button
                type="button"
                onClick={() => setHeadlineFocus("value")}
                aria-pressed={focusValue}
                title={focusValue ? undefined : "Show portfolio value as the headline figure"}
                className={cn(
                  "rounded text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  focusValue
                    ? "text-2xl font-bold text-foreground"
                    : "text-base font-semibold text-muted-foreground hover:text-foreground",
                )}
              >
                {showStartValue && (
                  <>
                    <span className={focusValue ? "text-muted-foreground" : undefined}>
                      {formatCurrency(headBasis)}
                    </span>
                    <span className="text-muted-foreground mx-1.5">→</span>
                  </>
                )}
                {formatCurrency(headValue)}
              </button>
              <button
                type="button"
                onClick={() => setHeadlineFocus("change")}
                aria-pressed={!focusValue}
                title={focusValue ? "Show the change as the headline figure" : undefined}
                className={cn(
                  "rounded transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  headPositive ? "text-success" : "text-destructive",
                  focusValue
                    ? "text-base font-semibold opacity-75 hover:opacity-100"
                    : "text-2xl font-bold",
                )}
              >
                {headPositive ? "+" : ""}{formatCurrency(headGain)} ({headPositive ? "+" : ""}{headGainPct.toFixed(2)}%)
              </button>
              {isIntraday && (
                <span className="text-xs text-muted-foreground">
                  {interval === "1m" ? "today's change" : "period change"}
                </span>
              )}
              {/* Kept to a sentence or two: the tip opens upward from the top of
                  the card, and a paragraph there ran off the edge. */}
              <InfoTooltip text={
                interval === "1m"
                  ? "Today's change since the previous close. Prices may be delayed and update during market hours."
                  : interval === "1h"
                  ? "Change over this period. Prices may be delayed and update during market hours."
                  : "Change over this period, based on daily closing prices."
              } />
              {interval === "1m" && session && !session.market_open && (
                <span className="text-xs font-medium text-muted-foreground bg-muted/60 px-2 py-0.5 rounded-full">
                  Market closed{!session.is_current && session.date ? ` · ${fmtSessionDate(session.date)}` : ""}
                </span>
              )}
            </div>
          )}
          {hasData && hasOverlays && (
            <p className="text-xs text-muted-foreground mt-0.5">Showing % change from period start</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* $ / % view-mode toggle — hidden when ticker overlays are active (already % mode) */}
          {!hasOverlays && (
            <div className="flex rounded-md border border-border overflow-hidden text-xs font-medium shrink-0">
              <button
                onClick={() => setViewMode("dollar")}
                className={cn(
                  "px-2.5 py-1 transition-colors",
                  viewMode === "dollar"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground bg-background",
                )}
              >
                $
              </button>
              <button
                onClick={() => setViewMode("pct")}
                className={cn(
                  "px-2.5 py-1 border-l border-border transition-colors",
                  viewMode === "pct"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground bg-background",
                )}
              >
                %
              </button>
            </div>
          )}
          {zoom.resetButton}
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
            onClearAll={() => setDateRange(null)}
          />
        </div>
      </div>

      <DailyRangeHint replaced={replaced} what="Plan values" className="-mt-1 mb-2" />

      {/* Chart */}
      <div {...zoom.wrapperProps}>
      {isLoading ? (
        <div className="h-40 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !hasData ? (
        <div className="h-40 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
          {isIntraday
            ? "No intraday data yet. Click Refresh to fetch market data."
            : "No price history yet. Click Refresh to fetch market data."}
        </div>
      ) : hasOverlays ? (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={chartData} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} {...zoom.chartProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={fmtAxis} ticks={overlayTicks} interval={0} />
            {zoom.area}
            <YAxis tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} tick={{ fontSize: 10 }} width={56} />
            <Tooltip
              formatter={(v: number, name: string) => [
                `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
                name === "portfolio_pct" ? seriesLabel : overlayName(name.replace(/_pct$/, "")),
              ]}
              contentStyle={tooltipStyle}
              labelFormatter={fmtDate}
            />
            <Legend formatter={(v) => (
              <span className="text-xs text-foreground">
                {v === "portfolio_pct" ? seriesLabel : overlayName(v.replace(/_pct$/, ""))}
              </span>
            )} />
            <Line type="monotone" dataKey="portfolio_pct" name="portfolio_pct"
              stroke={isPositive ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} />
            {overlayTickers.map((ticker, i) => (
              <Line key={ticker} type="monotone" dataKey={`${ticker}_pct`} name={`${ticker}_pct`}
                stroke={OVERLAY_COLORS[i % OVERLAY_COLORS.length]}

                strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={displaySeries} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} {...zoom.chartProps}>
            <defs>
              {/* Dollar mode: single-color gradient */}
              <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={isPositive ? "#22c55e" : "#ef4444"} stopOpacity={0.2} />
                <stop offset="95%" stopColor={isPositive ? "#22c55e" : "#ef4444"} stopOpacity={0} />
              </linearGradient>
              {/* Pct mode: green above zero, red below — transition at the zero crossing */}
              <linearGradient id="pctFillGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"          stopColor="#22c55e" stopOpacity={0.25} />
                <stop offset={zeroStopPct} stopColor="#22c55e" stopOpacity={0.05} />
                <stop offset={zeroStopPct} stopColor="#ef4444" stopOpacity={0.05} />
                <stop offset="100%"        stopColor="#ef4444" stopOpacity={0.25} />
              </linearGradient>
              <linearGradient id="pctStrokeGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"          stopColor="#22c55e" />
                <stop offset={zeroStopPct} stopColor="#22c55e" />
                <stop offset={zeroStopPct} stopColor="#ef4444" />
                <stop offset="100%"        stopColor="#ef4444" />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10 }}
              tickFormatter={fmtAxis}
              ticks={isIntraday ? intradayTicks : dailyTicks}
              interval={0}
            />
            <YAxis
              tickFormatter={viewMode === "pct"
                ? (v) => `${v >= 0 ? "+" : ""}${v.toFixed(pctDigits)}%`
                : dollarAxis?.tickFormatter}
              tick={{ fontSize: 10 }}
              width={56}
              domain={viewMode === "pct" ? pctDomain : dollarAxis?.domain}
              ticks={viewMode === "pct" ? pctScale?.ticks : dollarAxis?.ticks}
            />
            <Tooltip content={renderTooltip} />
            {zoom.area}
            <Area type="monotone" dataKey="value"
              stroke={viewMode === "pct" ? "url(#pctStrokeGrad)" : (isPositive ? "#22c55e" : "#ef4444")}
              strokeWidth={2}
              fill={viewMode === "pct" ? "url(#pctFillGrad)" : "url(#trendGrad)"}
              dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      </div>

    </div>
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
const inputCls = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";
const inputSmCls = "rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50";

// ── Column-order helpers ──────────────────────────────────────────────────────

const STOCK_COL_KEYS = [
  "favorite", "ticker", "account", "shares", "price",
  "day_change", "day_range", "week52_range", "current_value", "day_gain", "cost_basis",
  "basis_per_share", "total_gain", "return_pct",
] as const;
type StockColKey = typeof STOCK_COL_KEYS[number];

function loadStockColOrder(): StockColKey[] {
  try {
    const raw = localStorage.getItem("paiso-stocks-col-order");
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const valid = parsed.filter((k): k is StockColKey => STOCK_COL_KEYS.includes(k as StockColKey));
      const missing = STOCK_COL_KEYS.filter((k) => !valid.includes(k));
      return [...valid, ...missing];
    }
  } catch { /* ignore */ }
  return [...STOCK_COL_KEYS];
}

function saveStockColOrder(order: StockColKey[]) {
  try { localStorage.setItem("paiso-stocks-col-order", JSON.stringify(order)); } catch { /* ignore */ }
}

function loadSavedColDefault(): StockColKey[] | null {
  try {
    const raw = localStorage.getItem("paiso-stocks-col-saved-default");
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      const valid = parsed.filter((k): k is StockColKey => STOCK_COL_KEYS.includes(k as StockColKey));
      const missing = STOCK_COL_KEYS.filter((k) => !valid.includes(k));
      if (valid.length > 0) return [...valid, ...missing];
    }
  } catch { /* ignore */ }
  return null;
}

function saveSavedColDefault(order: StockColKey[]) {
  try { localStorage.setItem("paiso-stocks-col-saved-default", JSON.stringify(order)); } catch { /* ignore */ }
}

// Columns the user is allowed to hide — the star and ticker are the row's
// identity and always stay visible.
const ALWAYS_VISIBLE_COLS: StockColKey[] = ["favorite", "ticker"];

// Off until the user turns them on from Columns: with every column showing,
// the table needed sideways scrolling at 1280px. Each is a detail of
// a column that stays: the price, the intraday change, the cost basis.
const DEFAULT_HIDDEN_COLS: StockColKey[] = ["day_range", "week52_range", "day_gain", "basis_per_share"];

function loadHiddenCols(): StockColKey[] {
  try {
    const raw = localStorage.getItem("paiso-stocks-col-hidden");
    if (raw) {
      const parsed = JSON.parse(raw) as string[];
      return parsed.filter(
        (k): k is StockColKey =>
          STOCK_COL_KEYS.includes(k as StockColKey) && !ALWAYS_VISIBLE_COLS.includes(k as StockColKey),
      );
    }
  } catch { /* ignore */ }
  return [...DEFAULT_HIDDEN_COLS];
}

function saveHiddenCols(hidden: StockColKey[]) {
  try { localStorage.setItem("paiso-stocks-col-hidden", JSON.stringify(hidden)); } catch { /* ignore */ }
}

// ── Trade History View ────────────────────────────────────────────────────────

interface PendingRow {
  uid: number;
  trade_date: string;
  action: TradeAction;
  shares: string;
  price_per_share: string;
  amount: string;       // cash received (income actions)
  split_ratio: string;  // split actions
}

let _uid = 1;
function newRow(): PendingRow {
  return { uid: _uid++, trade_date: today(), action: "buy", shares: "", price_per_share: "", amount: "", split_ratio: "" };
}

function fmtTradeDate(iso: string) {
  return formatDate(iso);
}

const ACTION_LABELS: Record<TradeAction, string> = {
  buy: "BUY", sell: "SELL", dividend: "DIVIDEND", reinvest: "REINVEST",
  interest: "INTEREST", capgain: "CAP GAIN", split: "SPLIT",
  fee: "FEE", transfer_in: "TRANSFER IN", transfer_out: "TRANSFER OUT",
};

const ACTION_BADGE: Record<TradeAction, string> = {
  buy: "bg-success/10 text-success",
  sell: "bg-destructive/10 text-destructive",
  dividend: "bg-primary/10 text-primary",
  reinvest: "bg-primary/10 text-primary",
  interest: "bg-primary/10 text-primary",
  capgain: "bg-primary/10 text-primary",
  split: "bg-amber-500/15 text-amber-600",
  fee: "bg-muted text-muted-foreground",
  transfer_in: "bg-muted text-muted-foreground",
  transfer_out: "bg-muted text-muted-foreground",
};

/** Actions where shares change hands, so a share price means something. */
const SHARE_ACTIONS: TradeAction[] = ["buy", "sell", "reinvest", "transfer_in", "transfer_out"];

function isIncomeAction(a: TradeAction): boolean {
  return (INCOME_ACTIONS as string[]).includes(a);
}

/** Whether a pending row has enough data to be saved. */
/** A row nothing has been typed into. Save skips it rather than flagging it. */
function rowIsBlank(r: PendingRow): boolean {
  return !r.shares.trim() && !r.price_per_share.trim() && !r.amount.trim() && !r.split_ratio.trim();
}

/** Why a pending row cannot be saved, or null when it can. Save stays
 *  enabled and shows this under the table instead of greying out with no
 *  reason given. */
function rowProblem(r: PendingRow): string | null {
  const positive = (v: string) => v.trim() !== "" && Number(v) > 0;
  if (r.action === "buy" || r.action === "sell") {
    if (!positive(r.shares)) return "Enter a number of shares above 0.";
  } else if (r.action === "split") {
    if (!positive(r.split_ratio)) return "Enter a split ratio above 0, for example 2 for a 2-for-1 split.";
  } else if (r.action === "reinvest") {
    if (!positive(r.amount)) return "Enter the amount reinvested, above $0.";
    if (!positive(r.shares)) return "Enter the shares bought, above 0.";
  } else if (!positive(r.amount)) {
    return "Enter the amount received, above $0."; // dividend / interest / capgain
  }
  if (r.price_per_share.trim() !== "" && !(Number(r.price_per_share) >= 0)) {
    return "The price per share cannot be negative.";
  }
  return null;
}

function rowIsValid(r: PendingRow): boolean {
  return rowProblem(r) === null;
}

/** The rows Save would send, or the first reason it cannot. */
function checkPending(rows: PendingRow[]): { valid: PendingRow[]; problem: string | null } {
  const filled = rows.filter((r) => !rowIsBlank(r));
  if (filled.length === 0) return { valid: [], problem: "Add at least one trade: enter the shares bought." };
  for (const [i, r] of filled.entries()) {
    const p = rowProblem(r);
    if (p) return { valid: [], problem: filled.length > 1 ? `Row ${i + 1}: ${p}` : p };
  }
  return { valid: filled, problem: null };
}

/** Shared editable pending-trade rows (used by TradeHistoryView and PendingTradeForm).
 *  Every button in Trade History says type="button": the holding drawer wraps it
 *  in its form, and a bare button there submits it, which saved and closed the
 *  drawer on "Add row". */
function PendingTradeRows({ rows, allowIncome, onUpdate, onRemove, showErrors = false }: {
  rows: PendingRow[];
  allowIncome: boolean;
  /** Outline the rows Save refused. */
  showErrors?: boolean;
  onUpdate: (uid: number, field: keyof Omit<PendingRow, "uid">, value: string) => void;
  onRemove: (uid: number) => void;
}) {
  return (
    <>
      {rows.map((row) => {
        const income = isIncomeAction(row.action);
        const hasShares = row.action === "buy" || row.action === "sell" || row.action === "reinvest";
        const bad = showErrors && !rowIsBlank(row) && !rowIsValid(row);
        const badCls = bad ? "border-destructive" : "";
        return (
          <tr key={row.uid} className="bg-primary/5" aria-invalid={bad || undefined}>
            <td className="px-2 py-1.5">
              <input type="date" min={EARLIEST_DATE} max={todayIso()} value={row.trade_date}
                onChange={e => onUpdate(row.uid, "trade_date", e.target.value)}
                className={cn(inputSmCls, "w-full")} />
            </td>
            <td className="px-2 py-1.5">
              <select value={row.action}
                onChange={e => onUpdate(row.uid, "action", e.target.value)}
                className={cn(inputSmCls, "w-full")}>
                <option value="buy">BUY</option>
                <option value="sell">SELL</option>
                {allowIncome && (
                  <>
                    <option value="dividend">DIVIDEND</option>
                    <option value="reinvest">REINVEST</option>
                    <option value="interest">INTEREST</option>
                    <option value="capgain">CAP GAIN</option>
                    <option value="split">SPLIT</option>
                  </>
                )}
              </select>
            </td>
            <td className="px-2 py-1.5">
              {row.action === "split" ? (
                <input type="number" step="any" placeholder="ratio" title="Split ratio (2 = 2-for-1)"
                  value={row.split_ratio} aria-label="Split ratio"
                  onChange={e => onUpdate(row.uid, "split_ratio", e.target.value)}
                  className={cn(inputSmCls, "w-full text-right", badCls)} />
              ) : hasShares ? (
                <input type="number" step="any" min={0} placeholder="0" value={row.shares} aria-label="Shares"
                  onChange={e => onUpdate(row.uid, "shares", e.target.value)}
                  className={cn(inputSmCls, "w-full text-right", badCls)} />
              ) : (
                <span className="block text-right text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-2 py-1.5">
              {hasShares ? (
                <input type="number" step="any" min={0} placeholder="opt." value={row.price_per_share} aria-label="Price per share"
                  onChange={e => onUpdate(row.uid, "price_per_share", e.target.value)}
                  className={cn(inputSmCls, "w-full text-right", badCls)} />
              ) : (
                <span className="block text-right text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-2 py-1.5">
              {income ? (
                <input type="number" step="any" placeholder="$" title="Cash amount received"
                  value={row.amount} aria-label="Amount"
                  onChange={e => onUpdate(row.uid, "amount", e.target.value)}
                  className={cn(inputSmCls, "w-full text-right", badCls)} />
              ) : (
                <span className="block text-right tabular-nums text-muted-foreground truncate">
                  {row.shares && row.price_per_share
                    ? formatCurrency(Number(row.shares) * Number(row.price_per_share))
                    : "—"}
                </span>
              )}
            </td>
            <td className="px-1 py-1.5 text-center">
              <button type="button" onClick={() => onRemove(row.uid)} aria-label="Remove row"
                className="p-1 rounded text-muted-foreground hover:text-foreground transition-colors">
                <Trash2 size={11} />
              </button>
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** yfinance-detected dividends the user hasn't recorded yet — confirm as cash or DRIP. */
const DIVIDEND_PANEL_COLLAPSED_COUNT = 8;

function DetectedDividendsPanel({ holding }: { holding: Holding }) {
  const { data } = useDividendSuggestions(holding.id, true);
  const confirm = useConfirmDividends();
  const refresh = useRefreshDividends();
  const [expanded, setExpanded] = useState(false);

  // Without buy trades we can't compute shares-held on ex-dates, so a sync
  // wouldn't surface anything — hide the panel entirely.
  if (data?.reason === "no_trade_history") return null;

  const unrecorded = (data?.suggestions ?? []).filter(s => !s.already_recorded);
  const visible = expanded ? unrecorded : unrecorded.slice(0, DIVIDEND_PANEL_COLLAPSED_COUNT);
  const hiddenCount = unrecorded.length - visible.length;

  function record(s: { ex_date: string; total: number; price_hint: number | null }, asDrip: boolean) {
    // DRIP share count estimated from the ex-date's historical price, not
    // today's — using the current price would badly misstate old dividends.
    // Falls back to the current price only when yfinance had no close for
    // that day; user can delete + re-add manually for exact broker numbers.
    const price = s.price_hint ?? holding.price;
    confirm.mutate({
      holdingId: holding.id,
      confirmations: [{
        ex_date: s.ex_date,
        action: asDrip ? "reinvest" : "dividend",
        amount: s.total,
        ...(asDrip && price > 0 ? { shares: s.total / price, price_per_share: price } : {}),
      }],
    });
  }

  // Feedback line under the header after a manual sync.
  let syncMsg: string | null = null;
  if (!refresh.isPending && refresh.data) {
    syncMsg = refresh.data.refreshed
      ? `Synced ${holding.ticker}'s dividend history.`
      : "Already up to date. Dividends refresh at most once a day.";
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-primary uppercase tracking-wide">
          Detected dividends ({unrecorded.length})
        </p>
        <button type="button" onClick={() => refresh.mutate(holding.id)} disabled={refresh.isPending}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-primary transition-colors disabled:opacity-50">
          <RefreshCw size={11} className={refresh.isPending ? "animate-spin" : ""} />
          {refresh.isPending ? "Syncing…" : "Check for dividends"}
        </button>
      </div>

      {unrecorded.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No unrecorded dividends for {holding.ticker}. Use “Check for dividends” to pull the latest history from the market.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Based on {holding.ticker}'s dividend history and your trade dates. These suggestions come from
            public market data, are best effort, and can be wrong, so check each one against your broker
            statement before you record it as cash or reinvested (DRIP).
          </p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto">
            {visible.map((s) => (
              <div key={s.ex_date} className="flex items-center gap-2 text-xs">
                <span className="tabular-nums text-muted-foreground w-20">{fmtTradeDate(s.ex_date)}</span>
                <span className="tabular-nums flex-1">
                  {formatCurrency(s.amount_per_share)}/sh × {s.shares_held.toLocaleString(undefined, { maximumFractionDigits: 4 })} = <span className="font-medium">{formatCurrency(s.total)}</span>
                </span>
                <button type="button" onClick={() => record(s, false)} disabled={confirm.isPending}
                  className="px-2 py-0.5 rounded border border-border hover:border-primary/50 hover:text-primary transition-colors">
                  Cash
                </button>
                <button type="button" onClick={() => record(s, true)} disabled={confirm.isPending}
                  className="px-2 py-0.5 rounded border border-border hover:border-primary/50 hover:text-primary transition-colors">
                  DRIP
                </button>
              </div>
            ))}
          </div>
          {hiddenCount > 0 && (
            <button type="button" onClick={() => setExpanded(true)}
              className="text-[11px] text-primary hover:underline">
              Show {hiddenCount} more
            </button>
          )}
          {expanded && unrecorded.length > DIVIDEND_PANEL_COLLAPSED_COUNT && (
            <button type="button" onClick={() => setExpanded(false)}
              className="text-[11px] text-muted-foreground hover:underline">
              Show less
            </button>
          )}
        </>
      )}

      {refresh.isError && (
        <p className="text-[11px] text-destructive">{(refresh.error as Error).message}</p>
      )}
      {syncMsg && <p className="text-[11px] text-muted-foreground">{syncMsg}</p>}
      {confirm.error && (
        <p className="text-xs text-destructive">{(confirm.error as Error).message}</p>
      )}
    </div>
  );
}

function rowToTradeBody(r: PendingRow) {
  const income = isIncomeAction(r.action);
  return {
    trade_date: r.trade_date,
    action: r.action,
    shares: r.action === "buy" || r.action === "sell" || r.action === "reinvest" ? Number(r.shares) : 0,
    price_per_share:
      (r.action === "buy" || r.action === "sell" || r.action === "reinvest") && r.price_per_share
        ? Number(r.price_per_share) : undefined,
    amount: income && r.amount ? Number(r.amount) : undefined,
    split_ratio: r.action === "split" ? Number(r.split_ratio) : undefined,
  };
}

/** What the holding drawer's own Save asks of the trade rows typed into Trade
 *  History, so the drawer has one Save button rather than two. */
interface PendingTradesHandle {
  /** Why the typed rows cannot be saved, or null. Outlines the bad rows. */
  check: () => string | null;
  /** Save the typed rows, if any, and clear them. */
  save: () => Promise<void>;
}

function TradeHistoryView({ holding, handleRef }: {
  holding: Holding;
  handleRef: React.MutableRefObject<PendingTradesHandle | null>;
}) {
  const { data: trades = [], isLoading } = useTrades(holding.id);
  const createTrade = useCreateTrade();
  const deleteTrade = useDeleteTrade();

  const [pending, setPending] = useState<PendingRow[]>(() => [newRow()]);

  function addRow() { setPending(r => [...r, newRow()]); }
  function removeRow(uid: number) { setPending(r => r.length > 1 ? r.filter(x => x.uid !== uid) : r); }
  function updateRow(uid: number, field: keyof Omit<PendingRow, "uid">, value: string) {
    setPending(r => r.map(x => x.uid === uid ? { ...x, [field]: value } : x));
  }

  const [tried, setTried] = useState(false);
  // Untouched rows are not a mistake here: the drawer is often saved for its
  // other fields with the blank starter row still showing.
  const nothingTyped = pending.every(rowIsBlank);
  const pendingCheck = checkPending(pending);
  const problem = nothingTyped ? null : pendingCheck.problem;

  handleRef.current = {
    check: () => {
      setTried(true);
      return problem;
    },
    save: async () => {
      if (nothingTyped || problem) return;
      for (const row of pendingCheck.valid) {
        await createTrade.mutateAsync({ holdingId: holding.id, ...rowToTradeBody(row) });
      }
      setPending([newRow()]);
      setTried(false);
    },
  };
  useEffect(() => () => { handleRef.current = null; }, [handleRef]);

  const counted = trades;
  const heldShares = holding.shares ?? 0;
  const totalBuy = counted.filter(t => t.action === "buy" || t.action === "reinvest" || t.action === "transfer_in").reduce((s, t) => s + t.shares, 0);
  const totalSell = counted.filter(t => t.action === "sell" || t.action === "transfer_out").reduce((s, t) => s + t.shares, 0);
  const totalIncome = counted.filter(t => isIncomeAction(t.action)).reduce((s, t) => s + (t.amount ?? 0), 0);
  const hasSplits = counted.some(t => t.action === "split");
  const netShares = totalBuy - totalSell;

  return (
    <div className="px-3 py-3.5 space-y-4">
      <p className="text-xs text-muted-foreground -mt-1">
        Shares are auto-calculated from all trades.
      </p>

      {/* Summary pills */}
      {counted.length > 0 && (
        <div className="flex gap-3 text-xs flex-wrap">
          <span className="px-2.5 py-1 rounded-full bg-success/10 text-success font-medium">
            +{totalBuy.toLocaleString(undefined, { maximumFractionDigits: 4 })} bought
          </span>
          {totalSell > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-destructive/10 text-destructive font-medium">
              −{totalSell.toLocaleString(undefined, { maximumFractionDigits: 4 })} sold
            </span>
          )}
          <span className="px-2.5 py-1 rounded-full bg-muted text-muted-foreground font-medium">
            {hasSplits
                ? `= ${heldShares.toLocaleString(undefined, { maximumFractionDigits: 4 })} held (after splits)`
                : `= ${netShares.toLocaleString(undefined, { maximumFractionDigits: 4 })} net`}
          </span>
          {totalIncome > 0 && (
            <span className="px-2.5 py-1 rounded-full bg-primary/10 text-primary font-medium">
              {formatCurrency(totalIncome)} income received
            </span>
          )}
        </div>
      )}

      {/* Dividends found in market data, awaiting confirmation. */}
      {holding.ticker && <DetectedDividendsPanel holding={holding} />}

      {/* Saved trades */}
      {(isLoading || trades.length > 0) && (
        <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
          <table className={"w-full text-xs min-w-[440px]"}>
            <thead className="bg-muted border-b border-border">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Date</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Action</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Shares</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Price</th>
                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-1 py-2 w-6" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {isLoading ? (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">Loading…</td></tr>
              ) : trades.map((t) => {
                // Total column: cash amount for income actions, shares × price for buy/sell
                const total = isIncomeAction(t.action) || t.action === "fee"
                  ? t.amount
                  : t.price_per_share != null ? t.shares * t.price_per_share : null;
                // Some institutions send a price of 1.00 with a dividend.
                const price = SHARE_ACTIONS.includes(t.action) ? t.price_per_share : null;
                return (
                  <tr key={t.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2 tabular-nums">{fmtTradeDate(t.trade_date)}</td>
                    <td className="px-3 py-2">
                      <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap", ACTION_BADGE[t.action])}>
                        {ACTION_LABELS[t.action]}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.action === "split"
                        ? `${(t.split_ratio ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} : 1`
                        : t.shares > 0 ? t.shares.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{price != null ? formatCurrency(price) : "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{total != null ? formatCurrency(total) : "—"}</td>
                    <td className="px-1 py-2 text-center">
                      <button type="button" onClick={() => deleteTrade.mutate({ holdingId: holding.id, tradeId: t.id })}
                        className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/5 transition-colors"
                        disabled={deleteTrade.isPending}>
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pending rows to add */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add trades</p>
        <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "34%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "4%" }} />
            </colgroup>
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Date</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Action</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Shares</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Price</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-1 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              <PendingTradeRows rows={pending} allowIncome onUpdate={updateRow} onRemove={removeRow} showErrors={tried} />
            </tbody>
          </table>
        </div>

        <button type="button" onClick={addRow}
          className="w-full rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors flex items-center justify-center gap-1">
          <Plus size={11} /> Add row
        </button>
      </div>

      {tried && problem && (
        <p role="alert" className="text-xs text-destructive">{problem}</p>
      )}
      {!nothingTyped && (
        <p className="text-xs text-muted-foreground">Save changes below saves these trades with the rest of the holding.</p>
      )}

      {createTrade.error && (
        <p className="text-xs text-destructive">{(createTrade.error as Error).message}</p>
      )}
    </div>
  );
}

// ── Ticker Detail View (deep-dive: range, trend, analyst consensus, news) ──────

function RangeScale({ label, low, high, value }: {
  label: string; low: number | null | undefined; high: number | null | undefined; value: number | null | undefined;
}) {
  const ready = low != null && high != null && value != null && high > low;
  const pct = ready ? Math.min(Math.max(((value! - low!) / (high! - low!)) * 100, 0), 100) : 0;
  return (
    <div className="space-y-1.5">
      <p className={labelCls}>{label}</p>
      {!ready ? (
        <p className="text-xs text-muted-foreground">Not available</p>
      ) : (
        <>
          <div className="relative h-1.5 rounded-full bg-muted">
            <div
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 -translate-x-1/2 rounded-full bg-primary border-2 border-card shadow"
              style={{ left: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{formatCurrencyFull(low!)}</span>
            <span className="font-medium text-foreground">{formatCurrencyFull(value!)}</span>
            <span>{formatCurrencyFull(high!)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Compact horizontal range bar for table cells — same proportional-tick logic
 *  as RangeScale, sized for a table column instead of the drawer. */
export function MiniRangeScale({ low, high, value }: {
  low: number | null | undefined; high: number | null | undefined; value: number | null | undefined;
}) {
  const ready = low != null && high != null && value != null && high > low;
  if (!ready) return <span className="text-muted-foreground">—</span>;
  const pct = Math.min(Math.max(((value! - low!) / (high! - low!)) * 100, 0), 100);
  return (
    <div className="w-32">
      <div className="relative h-1.5 rounded-full bg-muted">
        <div
          className="absolute top-1/2 h-2.5 w-2.5 -translate-y-1/2 -translate-x-1/2 rounded-full bg-primary border-2 border-card shadow-sm"
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5 tabular-nums">
        <span>{formatCurrency(low!)}</span>
        <span>{formatCurrency(high!)}</span>
      </div>
    </div>
  );
}

/** Single-ticker price trend — reuses the same trend hook + date range picker as
 *  the portfolio chart above, filtered down to this one security. */
function TickerTrendMini({ holding }: { holding: Holding }) {
  const [dateRange, setDateRange] = useState<DateRange | null>(defaultRange);
  const trendRange: TrendRange | null = dateRange ? { from: dateRange.from, to: dateRange.to } : null;
  // Today and the one-week ranges use intraday bars, as the Performance chart
  // does; with daily closes "Today" was a single dot.
  const interval = intervalForRange(dateRange);
  const isIntraday = interval !== "1d";
  const { data, isLoading } = usePortfolioTrend(trendRange, undefined, [holding.security_id], true, interval);
  const ticker = holding.ticker ?? "";
  const series = data?.by_ticker?.[ticker] ?? [];
  const hasData = series.length > 0;
  const singleSession = interval === "1m";

  const span = spanInDays(series[0]?.date?.slice(0, 10), series[series.length - 1]?.date?.slice(0, 10));
  const fmtTime = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const fmtX = (d: string) => (!d.includes("T") ? formatAxisDate(d, span)
    : singleSession ? fmtTime(d)
    : new Date(d).toLocaleDateString([], { month: "short", day: "numeric" }));
  const fmtLabel = (d: string) => (!d.includes("T") ? formatDate(d)
    : `${new Date(d).toLocaleDateString([], { month: "short", day: "numeric" })}, ${fmtTime(d)}`);
  const yAxis = niceMoneyAxis(series.map((p) => p.close));
  const tooltipStyle = {
    background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95,
  };
  const isPositive = (series[series.length - 1]?.close ?? 0) >= (series[0]?.close ?? 0);
  // Drawer-width axis: five evenly-spaced dates, laid out from the newest back.
  const ticks = useMemo(() => evenTicks(series, "date", 5), [series]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className={labelCls}>
          Price Trend
          {singleSession && data?.session?.date && !data.session.is_current && (
            <span className="normal-case font-normal"> · last session, {sessionSuffix(data.session.date)}</span>
          )}
        </p>
        <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />
      </div>
      {isLoading ? (
        <div className="h-36 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !hasData ? (
        <div className="h-36 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
          {isIntraday ? "No intraday prices yet. They update during market hours." : "No price history for this range."}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={fmtX} ticks={ticks} interval={0} />
            <YAxis tickFormatter={yAxis?.tickFormatter} ticks={yAxis?.ticks} domain={yAxis?.domain ?? ["auto", "auto"]} tick={{ fontSize: 10 }} width={56} />
            <Tooltip formatter={(v: number) => [formatCurrencyFull(v), isIntraday ? "Price" : "Close"]} contentStyle={tooltipStyle} labelFormatter={(d) => fmtLabel(String(d))} />
            <Line type="monotone" dataKey="close" stroke={isPositive ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** What the Add holding form calls each stored holding type. */
const HOLDING_TYPE_LABELS: Record<string, string> = {
  stock: "Stock",
  etf: "ETF",
  mutual_fund: "Mutual fund",
  index_fund: "Index fund",
  "529_portfolio": "529 portfolio",
  custom: "Custom",
};

const ANALYST_RATING_LABEL: Record<string, string> = {
  strong_buy: "Strong Buy", strongbuy: "Strong Buy", buy: "Buy", outperform: "Outperform",
  hold: "Hold", neutral: "Neutral", underperform: "Underperform",
  sell: "Sell", strong_sell: "Strong Sell", strongsell: "Strong Sell",
};
function analystRatingLabel(key: string | null | undefined): string {
  if (!key) return "N/A";
  return ANALYST_RATING_LABEL[key.toLowerCase()]
    ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function analystRatingColor(key: string | null | undefined): string {
  const k = (key ?? "").toLowerCase();
  if (k.includes("buy") || k === "outperform") return "text-success bg-success/10";
  if (k.includes("sell") || k === "underperform") return "text-destructive bg-destructive/10";
  return "text-muted-foreground bg-muted";
}
function fmtNewsDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

// Fundamentals value formatters — each tolerates null (yfinance coverage varies a lot by ticker type).
function fmtCompactMoney(v: number | null): string { return v == null ? "—" : `$${formatCompact(v)}`; }
function fmtRatio(v: number | null): string { return v == null ? "—" : v.toFixed(2); }
function fmtPercent(v: number | null): string { return v == null ? "—" : `${v.toFixed(2)}%`; }
function fmtPercentFraction(v: number | null): string { return v == null ? "—" : `${(v * 100).toFixed(2)}%`; }

function FundamentalsGrid({ f }: { f: TickerFundamentals }) {
  const sectorIndustry = [f.sector, f.industry].filter(Boolean).join(" · ");
  const tiles: { label: string; value: string; wide?: boolean }[] = [
    { label: "Market Cap", value: fmtCompactMoney(f.market_cap) },
    ...(sectorIndustry ? [{ label: "Sector / Industry", value: sectorIndustry, wide: true }] : []),
    { label: "Dividend Yield", value: fmtPercent(f.dividend_yield) },
    { label: "EPS (TTM)", value: f.eps_ttm != null ? formatCurrencyFull(f.eps_ttm) : "—" },
    { label: "Forward P/E", value: fmtRatio(f.forward_pe) },
    { label: "Price/Book", value: fmtRatio(f.price_to_book) },
    { label: "Debt/Equity", value: fmtPercent(f.debt_to_equity) },
    { label: "Return on Equity", value: fmtPercentFraction(f.return_on_equity) },
    { label: "Revenue", value: fmtCompactMoney(f.revenue) },
    { label: "Gross Profit", value: fmtCompactMoney(f.gross_profit) },
    { label: "Free Cash Flow", value: fmtCompactMoney(f.free_cash_flow) },
    { label: "Beta", value: fmtRatio(f.beta) },
    { label: "Avg Volume", value: f.avg_volume != null ? formatCompact(f.avg_volume) : "—" },
    { label: "Short Ratio", value: fmtRatio(f.short_ratio) },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {tiles.map((t) => (
        <div key={t.label} className={cn("rounded-md bg-muted/30 px-2.5 py-2", t.wide && "col-span-2")}>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{t.label}</p>
          <p className="text-xs font-medium mt-0.5 truncate">{t.value}</p>
        </div>
      ))}
    </div>
  );
}

/** Shared deep-dive body — price header, ranges, trend, fundamentals, analyst
 *  consensus and news. Used both by the inline "Deep Dive" panel for a held
 *  ticker (see EditHoldingDrawer) and by the standalone ticker-lookup drawer,
 *  which has no Holding to anchor to. `trend` is injected by the caller since
 *  a held ticker charts against the portfolio's stored security history while
 *  a looked-up ticker charts against the ad-hoc market-history endpoint. The
 *  holding drawer shows its trend at the top of the drawer instead, so
 *  passes none. */
function TickerDeepDiveBody({ ticker, price, dayChange, dayChangePct, trend }: {
  ticker: string;
  price: number;
  dayChange: number;
  dayChangePct: number;
  trend?: React.ReactNode;
}) {
  const { data, isLoading, isError } = useTickerDetail(ticker, !!ticker);

  return (
    <div className="space-y-5">
      <p className="text-sm font-semibold">
        {data?.name ? `${data.name} (${ticker})` : ticker}
      </p>

      {/* Current price */}
      <div className="rounded-lg bg-muted/40 px-3 py-2.5 flex items-center justify-between">
        <div>
          <p className={labelCls}>Current Price</p>
          <p className="text-xl font-semibold">{formatCurrencyFull(price)}</p>
        </div>
        <span className={cn("text-sm font-medium", dayChange >= 0 ? "text-success" : "text-destructive")}>
          {dayChange >= 0 ? "+" : ""}{formatCurrencyFull(dayChange)}
          {" "}({dayChange >= 0 ? "+" : ""}{dayChangePct.toFixed(2)}%)
        </span>
      </div>

      {isLoading ? (
        <div className="h-24 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">Could not load deep-dive data. Try again later.</p>
      ) : (
        <>
          <RangeScale label="Today's Range" low={data.day_low} high={data.day_high} value={price} />
          <RangeScale label="52-Week Range" low={data.week52_low} high={data.week52_high} value={price} />
        </>
      )}

      {trend}

      {/* Fundamentals */}
          <div className="space-y-2">
            <p className={labelCls}>Fundamentals</p>
            {isLoading ? (
              <div className="h-16 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : !data?.fundamentals ? (
              <p className="text-xs text-muted-foreground">No fundamentals available.</p>
            ) : (
              <FundamentalsGrid f={data.fundamentals} />
            )}
          </div>

          {/* Analyst Consensus */}
          <div className="space-y-2">
            <p className={labelCls}>Analyst Consensus</p>
            {isLoading ? (
              <div className="h-16 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : !data?.analyst?.rating && data?.analyst?.score == null ? (
              <p className="text-xs text-muted-foreground">No analyst coverage available.</p>
            ) : (
              <div className="rounded-lg border border-border p-3 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", analystRatingColor(data.analyst.rating))}>
                    {analystRatingLabel(data.analyst.rating)}
                  </span>
                  {data.analyst.analyst_count != null && (
                    <span className="text-xs text-muted-foreground">{data.analyst.analyst_count} analysts</span>
                  )}
                </div>
                {typeof data.analyst.score === "number" && (
                  <div className="flex items-center gap-1">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div key={i} className={cn("h-1.5 flex-1 rounded-full", i <= Math.round(data.analyst.score!) ? "bg-primary" : "bg-muted")} />
                    ))}
                  </div>
                )}
                {(data.analyst.target_mean != null || data.analyst.target_high != null || data.analyst.target_low != null) && (
                  <div className="grid grid-cols-3 gap-2 text-center pt-1">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Low</p>
                      <p className="text-xs font-medium">{data.analyst.target_low != null ? formatCurrencyFull(data.analyst.target_low) : "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">Mean Target</p>
                      <p className="text-xs font-medium">{data.analyst.target_mean != null ? formatCurrencyFull(data.analyst.target_mean) : "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">High</p>
                      <p className="text-xs font-medium">{data.analyst.target_high != null ? formatCurrencyFull(data.analyst.target_high) : "—"}</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Top news */}
          <div className="space-y-2">
            <p className={labelCls}>Recent News</p>
            {isLoading ? (
              <div className="h-16 flex items-center justify-center">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              </div>
            ) : !data?.news?.length ? (
              <p className="text-xs text-muted-foreground">No recent news found.</p>
            ) : (
              <div className="space-y-2">
                {data.news.map((item, i) => (
                  <a
                    key={i}
                    href={item.url ?? undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md border border-border px-3 py-2 hover:bg-muted/40 transition-colors"
                  >
                    <p className="text-xs font-medium leading-snug line-clamp-2">{item.title ?? "Untitled"}</p>
                    <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
                      <span className="truncate">{item.publisher}{item.published_at ? ` · ${fmtNewsDate(item.published_at)}` : ""}</span>
                      <ExternalLink size={10} className="ml-auto shrink-0" />
                    </p>
                  </a>
                ))}
              </div>
            )}
          </div>
    </div>
  );
}

/** Inline deep-dive panel — collapses under the main edit form (see the "Deep
 *  Dive" toggle in EditHoldingDrawer) rather than swapping to a separate view,
 *  so the drawer keeps its normal width. Charts against the portfolio's stored
 *  security history via TickerTrendMini, which needs a real holding. */
function TickerDetailView({ holding }: { holding: Holding }) {
  const ticker = holding.ticker;
  if (!ticker) {
    return <p className="text-sm text-muted-foreground">Deep-dive data is not available for holdings without a ticker.</p>;
  }
  return (
    <TickerDeepDiveBody
      ticker={ticker}
      price={holding.price}
      dayChange={holding.day_change}
      dayChangePct={holding.day_change_pct}
    />
  );
}

/** Standalone-ticker trend chart for the ticker-lookup drawer — there's no
 *  portfolio security to chart against, so this hits the ad-hoc market-history
 *  endpoint (works for any symbol, held or not) with a simple range toggle
 *  instead of the full DateRangePicker/intraday machinery. */
function StandaloneTickerTrend({ ticker }: { ticker: string }) {
  const [range, setRange] = useState<MarketHistoryRange>("12m");
  const { data = [], isLoading } = useMarketHistory(ticker, range, true);
  const hasData = data.length > 0;
  const isPositive = (data[data.length - 1]?.close ?? 0) >= (data[0]?.close ?? 0);
  const ticks = useMemo(() => evenTicks(data, "date", 5), [data]);

  const span = spanInDays(data[0]?.date, data[data.length - 1]?.date);
  const yAxis = niceMoneyAxis(data.map((p) => p.close));
  const tooltipStyle = {
    background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.95,
  };
  const RANGES: { key: MarketHistoryRange; label: string }[] = [
    { key: "90d", label: "3M" },
    { key: "ytd", label: "YTD" },
    { key: "12m", label: "1Y" },
    { key: "prior_year", label: "Prior Yr" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className={labelCls}>Price Trend</p>
        <div className="flex rounded-md border border-border overflow-hidden text-xs font-medium shrink-0">
          {RANGES.map((r, i) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                "px-2 py-1 transition-colors",
                i > 0 && "border-l border-border",
                range === r.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground bg-background",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {isLoading ? (
        <div className="h-36 flex items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !hasData ? (
        <div className="h-36 flex items-center justify-center text-sm text-muted-foreground text-center px-4">
          No price history for this range.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => formatAxisDate(d, span)} ticks={ticks} interval={0} />
            <YAxis tickFormatter={yAxis?.tickFormatter} ticks={yAxis?.ticks} domain={yAxis?.domain ?? ["auto", "auto"]} tick={{ fontSize: 10 }} width={56} />
            <Tooltip formatter={(v: number) => [formatCurrencyFull(v), "Close"]} contentStyle={tooltipStyle} labelFormatter={(d) => formatDate(String(d))} />
            <Line type="monotone" dataKey="close" stroke={isPositive ? "#22c55e" : "#ef4444"} strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

/** Typeahead dropdown for the ticker-lookup search box — matches on ticker or
 *  company name and shows exchange/type so similarly-named companies (e.g.
 *  "Apple Inc." vs "Apple Hospitality REIT") can be told apart before picking
 *  one. */
function TickerSearchDropdown({ query, results, pending, highlightedIndex, onSelect }: {
  query: string;
  results: TickerSearchResult[];
  pending: boolean;
  highlightedIndex: number;
  onSelect: (result: TickerSearchResult) => void;
}) {
  return (
    <div className="absolute left-0 right-0 top-full mt-1 rounded-md border border-border bg-card shadow-lg z-20 max-h-72 overflow-y-auto">
      {pending ? (
        <div className="px-3 py-4 flex items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : results.length === 0 ? (
        <p className="px-3 py-3 text-xs text-muted-foreground text-center">
          No matches for "{query.trim()}". Try a different name or ticker.
        </p>
      ) : (
        results.map((r, i) => (
          <button
            key={`${r.symbol}-${i}`}
            type="button"
            // Mousedown (not click) fires before the input's blur handler, so
            // the dropdown doesn't close itself out from under the click.
            onMouseDown={(e) => { e.preventDefault(); onSelect(r); }}
            className={cn(
              "w-full flex items-center justify-between gap-3 px-3 py-2 text-left transition-colors",
              i === highlightedIndex ? "bg-muted/60" : "hover:bg-muted/40",
            )}
          >
            <span className="min-w-0">
              <span className="text-sm font-medium">{r.symbol}</span>
              <span className="block text-xs text-muted-foreground truncate">{r.name}</span>
            </span>
            {r.exchange && (
              <span className="shrink-0 text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full">
                {r.exchange}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  );
}

/** Ticker/company-name input with a typeahead dropdown — the reusable core
 *  behind both the "Look up ticker" search box and the Add Holding form's
 *  ticker field. Picking a suggestion reports the full result (so callers can
 *  auto-fill dependent fields like the security name); typing a value the
 *  user never picks from the list is left for the caller to treat as a
 *  literal ticker symbol on submit/blur. */
function TickerSearchInput({ value, onChange, onSelect, placeholder = "Ticker or company name", className, inputClassName, autoFocus }: {
  value: string;
  onChange: (ticker: string) => void;
  onSelect?: (result: TickerSearchResult) => void;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  autoFocus?: boolean;
}) {
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debouncedQuery = useDebounce(value, 300);
  const { data: results = [], isFetching } = useTickerSearch(debouncedQuery, dropdownOpen);
  // Also pending while the debounce itself hasn't settled, so the dropdown
  // doesn't briefly flash "no matches" between keystrokes.
  const pending = isFetching || debouncedQuery.trim() !== value.trim();

  function selectResult(r: TickerSearchResult) {
    onChange(r.symbol);
    onSelect?.(r);
    setDropdownOpen(false);
    setHighlightedIndex(-1);
  }

  function handleChange(v: string) {
    onChange(v);
    setDropdownOpen(v.trim().length > 0);
    setHighlightedIndex(-1);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!dropdownOpen || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && highlightedIndex >= 0 && results[highlightedIndex]) {
      // Only intercept Enter when a suggestion is highlighted — otherwise let
      // it bubble so an enclosing <form>'s onSubmit still fires normally.
      e.preventDefault();
      selectResult(results[highlightedIndex]);
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
    }
  }

  return (
    <div className={cn("relative", className)}>
      <input
        type="text"
        autoFocus={autoFocus}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => setDropdownOpen(value.trim().length > 0)}
        onBlur={() => setDropdownOpen(false)}
        onKeyDown={handleKeyDown}
        className={inputClassName}
      />
      {dropdownOpen && (
        <TickerSearchDropdown
          query={value}
          results={results}
          pending={pending}
          highlightedIndex={highlightedIndex}
          onSelect={selectResult}
        />
      )}
    </div>
  );
}

/** Standalone ticker-search drawer — same deep-dive UX as the inline panel on
 *  an existing holding, but for any symbol, including ones not in the
 *  portfolio. Lets the user add it as a new holding straight from here.
 *  Search matches on ticker or company name via a typeahead dropdown, so the
 *  user doesn't need to already know the exact symbol. */
function TickerLookupDrawer({ open, onClose, onAddToPortfolio }: {
  open: boolean;
  onClose: () => void;
  onAddToPortfolio: (ticker: string) => void;
}) {
  const [input, setInput] = useState("");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const debouncedQuery = useDebounce(input, 300);
  const { data: searchResults = [], isFetching: searchFetching } = useTickerSearch(debouncedQuery, open && dropdownOpen);
  // Also pending while the debounce itself hasn't settled yet, so the
  // dropdown doesn't briefly flash "no matches" between keystrokes.
  const searchPending = searchFetching || debouncedQuery.trim() !== input.trim();
  const { data, isLoading, isError } = useTickerDetail(symbol, !!symbol);

  function handleClose() {
    setInput("");
    setSymbol(null);
    setDropdownOpen(false);
    onClose();
  }

  function selectResult(r: TickerSearchResult) {
    setSymbol(r.symbol);
    setInput(r.symbol);
    setDropdownOpen(false);
    setHighlightedIndex(-1);
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (highlightedIndex >= 0 && searchResults[highlightedIndex]) {
      selectResult(searchResults[highlightedIndex]);
      return;
    }
    // No suggestion picked — if the typed text is an exact match (ticker or
    // name) among the current suggestions, use it; otherwise fall back to
    // treating it as a literal ticker symbol.
    const exact = searchResults.find(
      (r) => r.symbol.toLowerCase() === input.trim().toLowerCase() || r.name.toLowerCase() === input.trim().toLowerCase(),
    );
    const s = (exact?.symbol ?? input.trim()).toUpperCase();
    if (s) {
      setSymbol(s);
      setInput(s);
      setDropdownOpen(false);
    }
  }

  function handleInputChange(v: string) {
    setInput(v);
    setDropdownOpen(v.trim().length > 0);
    setHighlightedIndex(-1);
    // Editing the box after a result was shown starts a fresh search.
    if (symbol) setSymbol(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!dropdownOpen || searchResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, searchResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
    }
  }

  // get_ticker_detail returns zeroed/null fields (never a hard error) for an
  // unknown symbol, so "not found" has to be inferred from an empty payload
  // rather than isError.
  const notFound = !!symbol && !isLoading && !isError && data && !data.name && !data.price;

  return (
    <SideDrawer open={open} onClose={handleClose} title="Look up ticker">
      <div className="px-5 py-5 space-y-5">
        <form onSubmit={handleSearch} className="flex items-center gap-2 relative">
          <div className="flex items-center flex-1 rounded-md border border-border bg-background px-3 gap-2">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              autoFocus
              placeholder="Ticker or company name, e.g. Apple"
              value={input}
              onChange={(e) => handleInputChange(e.target.value)}
              onFocus={() => setDropdownOpen(input.trim().length > 0)}
              onKeyDown={handleKeyDown}
              className="flex-1 py-2 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground min-w-0"
            />
          </div>
          <Button type="submit" size="sm" disabled={!input.trim()}>Search</Button>
          {dropdownOpen && (
            <TickerSearchDropdown
              query={input}
              results={searchResults}
              pending={searchPending}
              highlightedIndex={highlightedIndex}
              onSelect={selectResult}
            />
          )}
        </form>

        {!symbol ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Search any ticker or company name to see its price, ranges, fundamentals, analyst consensus and news, including ones you do not hold.
          </p>
        ) : isLoading ? (
          <div className="h-24 flex items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : isError || notFound ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Could not find "{symbol}". Check the spelling or try searching by company name instead.
          </p>
        ) : (
          <>
            <TickerDeepDiveBody
              ticker={symbol}
              price={data?.price ?? 0}
              dayChange={data?.day_change ?? 0}
              dayChangePct={data?.day_change_pct ?? 0}
              trend={<StandaloneTickerTrend ticker={symbol} />}
            />
            <Button className="w-full" onClick={() => onAddToPortfolio(symbol)}>
              <Plus size={13} /> Add to portfolio
            </Button>
          </>
        )}
      </div>
    </SideDrawer>
  );
}

// ── Pending Trade Form (used in add flow — creates holding+trades atomically) ──

interface PendingTradeFormProps {
  formData: { account_id: number; ticker: string; name: string; type: string; expense_ratio: string };
  onBack: () => void;
  onSaved: (h: Holding) => void;
}

function PendingTradeForm({ formData, onBack, onSaved }: PendingTradeFormProps) {
  const create = useCreateHolding();
  const createTrade = useCreateTrade();
  // New-holding flow starts with purchases only; income/split entries come later
  // from the holding's trade history once a position exists.
  const allowIncome = false;
  const [pending, setPending] = useState<PendingRow[]>(() => [newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addRow() { setPending(r => [...r, newRow()]); }
  function removeRow(uid: number) { setPending(r => r.length > 1 ? r.filter(x => x.uid !== uid) : r); }
  function updateRow(uid: number, field: keyof Omit<PendingRow, "uid">, value: string) {
    setPending(r => r.map(x => x.uid === uid ? { ...x, [field]: value } : x));
  }

  const [tried, setTried] = useState(false);
  const pendingCheck = checkPending(pending);

  async function handleSave() {
    setTried(true);
    const { valid, problem } = pendingCheck;
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      // Only NOW create the holding — no orphan is possible if user cancels before this
      const holding = await create.mutateAsync({
        account_id: Number(formData.account_id),
        security: {
          ticker: formData.ticker.toUpperCase() || undefined,
          name: formData.name || formData.ticker.toUpperCase() || "Unnamed",
          type: formData.type,
          expense_ratio: formData.expense_ratio ? Number(formData.expense_ratio) : undefined,
        },
      });
      for (const row of valid) {
        await createTrade.mutateAsync({
          holdingId: holding.id,
          trade_date: row.trade_date,
          action: row.action,
          shares: Number(row.shares),
          price_per_share: row.price_per_share ? Number(row.price_per_share) : undefined,
        });
      }
      onSaved(holding);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const label = formData.ticker.toUpperCase() || formData.name || "New holding";

  return (
    <div className="px-5 py-5 space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onBack} aria-label="Back" className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
          <ChevronLeft size={16} />
        </button>
        <div>
          <p className="text-sm font-semibold">{label}: Trade History</p>
          <p className="text-xs text-muted-foreground">Holding is created only after you save your first trade.</p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add trades</p>
        <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "34%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "4%" }} />
            </colgroup>
            <thead className="bg-muted/50 border-b border-border">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Date</th>
                <th className="px-2 py-1.5 text-left font-medium text-muted-foreground">Action</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Shares</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Price</th>
                <th className="px-2 py-1.5 text-right font-medium text-muted-foreground">Total</th>
                <th className="px-1 py-1.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              <PendingTradeRows rows={pending} allowIncome={allowIncome} onUpdate={updateRow} onRemove={removeRow} showErrors={tried} />
            </tbody>
          </table>
        </div>
        <button onClick={addRow}
          className="w-full rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors flex items-center justify-center gap-1">
          <Plus size={11} /> Add row
        </button>
      </div>

      {tried && pendingCheck.problem && (
        <p role="alert" className="text-xs text-destructive">{pendingCheck.problem}</p>
      )}
      <Button size="sm" className="w-full" loading={saving}
        onClick={handleSave} disabled={saving}>
        Save trades and create holding
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ── Add Holding Drawer ────────────────────────────────────────────────────────

export function AddHoldingDrawer({ open, onClose, onCreated, initialTicker }: {
  open: boolean;
  onClose: () => void;
  onCreated: (h: Holding) => void;
  initialTicker?: string;
}) {
  const { data: accounts = [] } = useAccounts();
  const createAccount = useCreateAccount();
  const investmentAccounts = accounts.filter((a) =>
    ["brokerage", "401k", "ira", "roth_ira", "hsa", "529"].includes(a.account_type),
  );
  const [form, setForm] = useState({ account_id: investmentAccounts[0]?.id ?? 0, ticker: initialTicker ?? "", name: "", type: "stock", expense_ratio: "" });
  const [showTrades, setShowTrades] = useState(false);

  async function createBrokerage() {
    const acct = await createAccount.mutateAsync({
      display_name: "Brokerage", account_type: "brokerage",
    });
    setForm((f) => ({ ...f, account_id: acct.id }));
  }

  useEffect(() => {
    if (investmentAccounts.length > 0 && form.account_id === 0)
      setForm((f) => ({ ...f, account_id: investmentAccounts[0].id }));
  }, [investmentAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pick up a ticker handed in from the ticker-lookup drawer's "Add to portfolio" flow.
  useEffect(() => {
    if (open && initialTicker) setForm((f) => ({ ...f, ticker: initialTicker }));
  }, [open, initialTicker]);

  const set = (k: string, v: string | number) => setForm((f) => ({ ...f, [k]: v }));

  function handleClose() {
    setTried(false);
    setForm({ account_id: investmentAccounts[0]?.id ?? 0, ticker: "", name: "", type: "stock", expense_ratio: "" });
    setShowTrades(false);
    onClose();
  }

  function handleTradesSaved(holding: Holding) {
    onCreated(holding);
    handleClose();
  }

  // Checked here, before the trade step: the server used to reject a bad
  // expense ratio only on the last step, under fields from the first.
  // Same limit as the API's ExpenseRatioPct.
  const er = form.expense_ratio.trim();
  const expenseRatioError =
    er !== "" && !(Number(er) >= 0 && Number(er) <= 10)
      ? "Expense ratio must be between 0% and 10%."
      : null;
  // The next-step buttons stay enabled and say what is missing.
  const [tried, setTried] = useState(false);
  const accountError = form.account_id ? null : "Choose or create an investment account.";
  const tickerError = form.ticker.trim() || form.name.trim() ? null : "Enter a ticker symbol or a name.";
  const canAddTrades = !accountError && !tickerError && !expenseRatioError;

  return (
    <SideDrawer open={open} onClose={handleClose} title="Add holding">
      {showTrades ? (
        <PendingTradeForm
          formData={form}
          onBack={() => setShowTrades(false)}
          onSaved={handleTradesSaved}
        />
      ) : (
        <div className="px-5 py-5 space-y-4">
          <div className="space-y-1.5">
            <label className={labelCls}>Account</label>
            {investmentAccounts.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-3 space-y-2">
                <p className="text-xs text-muted-foreground">
                  You have no investment account yet. Create one to hold this position.
                </p>
                <button
                  type="button"
                  onClick={createBrokerage}
                  disabled={createAccount.isPending}
                  className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                >
                  {createAccount.isPending ? "Creating…" : "Create a brokerage account"}
                </button>
              </div>
            ) : (
              <select value={form.account_id} onChange={(e) => set("account_id", e.target.value)} className={inputCls}>
                {investmentAccounts.map((a) => <option key={a.id} value={a.id}>{a.display_name}</option>)}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={labelCls}>Ticker Symbol</label>
              <TickerSearchInput
                value={form.ticker}
                onChange={(v) => set("ticker", v)}
                onSelect={(r) => setForm((f) => ({ ...f, ticker: r.symbol, name: r.name }))}
                placeholder="AAPL or company name"
                inputClassName={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className={labelCls}>Type</label>
              <select value={form.type} onChange={(e) => set("type", e.target.value)} className={inputCls}>
                {["stock", "etf", "mutual_fund", "index_fund", "529_portfolio", "custom"].map((t) => (
                  <option key={t} value={t}>{HOLDING_TYPE_LABELS[t]}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Name <span className="normal-case font-normal text-muted-foreground/60">(auto-fetched if ticker provided)</span></label>
            <input type="text" placeholder="Apple Inc." value={form.name} onChange={(e) => set("name", e.target.value)} className={inputCls} />
          </div>
          <div className="space-y-1.5">
            <label className={labelCls}>Expense Ratio (%) <span className="normal-case font-normal text-muted-foreground/60">optional, for funds</span></label>
            <input type="number" min={0} max={10} step="0.01" placeholder="0.03" value={form.expense_ratio} onChange={(e) => set("expense_ratio", e.target.value)} aria-invalid={expenseRatioError ? true : undefined} className={cn(inputCls, expenseRatioError && "border-destructive")} />
            {expenseRatioError && <p className="text-xs text-destructive">{expenseRatioError}</p>}
          </div>

          <>
              <button
                type="button"
                onClick={() => { setTried(true); if (canAddTrades) setShowTrades(true); }}
                className="w-full flex items-center justify-between rounded-md border border-border px-3 py-2.5 text-sm hover:bg-muted/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <History size={14} />
                  Add trade history
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-primary/10 text-primary">
                  required
                </span>
              </button>
              {tried && (accountError || tickerError || expenseRatioError) ? (
                <p role="alert" className="text-xs text-center text-destructive">
                  {accountError || tickerError || expenseRatioError}
                </p>
              ) : (
                <p className="text-xs text-center text-muted-foreground">
                  Fill in ticker and account above, then add at least one trade to create the holding.
                </p>
              )}
          </>
        </div>
      )}
    </SideDrawer>
  );
}

// ── Edit Holding Drawer ───────────────────────────────────────────────────────

/** A checkbox in a drawer, in the one shape every drawer uses. */
function DrawerCheckbox({ checked, onChange, icon, label, help }: {
  checked: boolean; onChange: (v: boolean) => void; icon: ReactNode; label: string; help: string;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 rounded border-border accent-primary" />
      <div>
        <p className="text-sm font-medium flex items-center gap-1.5">{icon}{label}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{help}</p>
      </div>
    </label>
  );
}

/** "Hide from table" and "Exclude from net worth", as every Holdings-table
 *  drawer offers them. Hiding only takes the row out of the table; excluding
 *  takes it out of every total. Both apply on Save. */
export function RowVisibilityFields({ hidden, onHidden, excluded, onExcluded, excludeHelp }: {
  hidden: boolean; onHidden: (v: boolean) => void;
  excluded: boolean; onExcluded: (v: boolean) => void; excludeHelp: string;
}) {
  return (
    <div className="border-t border-border pt-3 space-y-3">
      <DrawerCheckbox checked={hidden} onChange={onHidden}
        icon={<EyeOff size={13} className="text-muted-foreground" />} label="Hide from table"
        help="Takes the row out of this table. It still counts toward your totals." />
      <DrawerCheckbox checked={excluded} onChange={onExcluded}
        icon={<EyeOff size={13} className="text-muted-foreground" />} label="Exclude from net worth"
        help={excludeHelp} />
    </div>
  );
}

export const ACCOUNT_EXCLUDE_HELP =
  "This account will not be counted in your net worth. It still counts in Investments.";

/** The hidden flag of one row, read from and saved to ui_prefs. */
function useRowHidden(rowKey: string | null) {
  const hiddenRows = useUiPrefsStore((st) => st.hiddenHoldingRows);
  const setRowHidden = useUiPrefsStore((st) => st.setHoldingRowHidden);
  return [rowKey != null && hiddenRows.includes(rowKey),
    (v: boolean) => { if (rowKey != null) setRowHidden(rowKey, v); }] as const;
}

/** An account valued as one number: nothing itemises it. */
function BalanceRowDrawer({ row, onClose }: { row: Holding | null; onClose: () => void }) {
  const navigate = useNavigate();
  const updateAccount = useUpdateAccount();
  const [savedHidden, setHidden] = useRowHidden(row ? (row.row_key ?? null) : null);
  const [form, setForm] = useState({ hidden: false, excluded: false });
  useEffect(() => {
    if (row) setForm({ hidden: savedHidden, excluded: !!row.account_excluded });
  }, [row?.row_key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!row) return;
    if (row.account_id != null && form.excluded !== !!row.account_excluded) {
      await updateAccount.mutateAsync({ id: row.account_id, exclude_from_net_worth: form.excluded });
    }
    setHidden(form.hidden);
    onClose();
  }

  const asOf = row?.price_as_of
    ? new Date(`${row.price_as_of}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
    : null;
  return (
    <SideDrawer open={row != null} onClose={onClose} title={row?.account_name ?? "Account"}>
      {row && (
        <div className="px-5 py-5 space-y-4">
          <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Balance</span>
              <span className="font-medium">{formatCurrency(row.current_value)}</span>
            </div>
            {asOf && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">As of</span>
                <span className="font-medium">{asOf}</span>
              </div>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            This account is counted at the balance you entered; it lists no positions.
          </p>
          <RowVisibilityFields
            hidden={form.hidden} onHidden={(hidden) => setForm((f) => ({ ...f, hidden }))}
            excluded={form.excluded} onExcluded={(excluded) => setForm((f) => ({ ...f, excluded }))}
            excludeHelp={ACCOUNT_EXCLUDE_HELP} />
          {updateAccount.error && <p className="text-sm text-destructive">{(updateAccount.error as Error).message}</p>}
          <Button type="button" onClick={save} loading={updateAccount.isPending} className="w-full">Save changes</Button>
          <button type="button" onClick={() => navigate("/settings?tab=accounts")}
            className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors">
            Edit account in Settings
          </button>
        </div>
      )}
    </SideDrawer>
  );
}

export function EditHoldingDrawer({ holding, onClose, initialView = "main" }: {
  holding: Holding | null; onClose: () => void; initialView?: "main" | "trades";
}) {
  const [savedHidden, setHidden] = useRowHidden(holding ? (holding.row_key ?? `h:${holding.id}`) : null);
  const update = useUpdateHolding();
  const deleteHolding = useDeleteHolding();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tradesExpanded, setTradesExpanded] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const [form, setForm] = useState({ shares: "", cost_basis_total: "", exclude_from_net_worth: false, hidden: false, expense_ratio: "" });
  // Trade rows typed under Trade History, saved by this drawer's Save.
  const pendingTrades = useRef<PendingTradesHandle | null>(null);
  const [savingTrades, setSavingTrades] = useState(false);

  const holdingId = holding?.id;
  useEffect(() => {
    if (holding) {
      setForm({
        shares: holding.shares != null ? String(holding.shares) : "",
        cost_basis_total: holding.cost_basis_total != null ? String(holding.cost_basis_total) : "",
        exclude_from_net_worth: holding.holding_excluded ?? holding.exclude_from_net_worth,
        hidden: savedHidden,
        expense_ratio: "",
      });
      setConfirmDelete(false);
      setTradesExpanded(initialView === "trades");
      setDetailExpanded(false);
    }
  }, [holdingId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const sharesEditable = !holding?.has_trades;
  // Fee Analysis sends people here to add a fund's missing expense ratio.
  // The ratio belongs to the fund, which everyone holding that ticker
  // shares, so it can be filled while missing but not changed once known.
  const isFund = !!holding && !["stock", "cash"].includes(holding.type);
  const canFillExpenseRatio = isFund && holding?.expense_ratio == null;
  const erText = form.expense_ratio.trim();
  const expenseRatioError =
    erText !== "" && !(Number(erText) >= 0 && Number(erText) <= 10)
      ? "Expense ratio must be between 0% and 10%."
      : null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!holding || expenseRatioError) return;
    // Refuse the whole save, before anything is written, when a typed trade
    // row is incomplete; Trade History says which row and why.
    if (pendingTrades.current?.check()) {
      setTradesExpanded(true);
      return;
    }
    setHidden(form.hidden);
    await update.mutateAsync({
      id: holding.id,
      // Only send shares if not managed by trades.
      ...(sharesEditable && form.shares.trim() !== "" ? { shares: Number(form.shares) } : {}),
      // `Number("")` is 0, and 0 means "this cost nothing" — which the table
      // reads as the whole position being profit. An empty field means nobody
      // recorded the cost, so send null and let it stay unknown.
      cost_basis_total:
        form.cost_basis_total.trim() === "" ? null : Number(form.cost_basis_total),
      exclude_from_net_worth: form.exclude_from_net_worth,
      ...(canFillExpenseRatio && erText !== "" ? { expense_ratio: Number(erText) } : {}),
    });
    // Trades last: adding one recalculates shares and cost basis from the
    // trades, and that must win over the figures the form sent above.
    setSavingTrades(true);
    try {
      await pendingTrades.current?.save();
    } finally {
      setSavingTrades(false);
    }
    onClose();
  }

  async function handleDelete() {
    if (!holding) return;
    await deleteHolding.mutateAsync(holding.id);
    onClose();
  }

  const drawerTitle = holding
    ? <HoldingDrawerTitle ticker={holding.ticker} name={holding.name} />
    : "Edit holding";

  return (
    <SideDrawer open={holding != null} onClose={onClose} title={drawerTitle}>
      {holding && (
          <form onSubmit={handleSave} className="px-5 py-5 space-y-4">
            {/* The price trend leads the drawer; it used to sit inside Deep Dive. */}
            {holding.ticker && <TickerTrendMini holding={holding} />}
            {/* Read-only header info */}
            <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Account</span>
                <span className="font-medium">{holding.account_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Price</span>
                <span className="font-medium">{formatCurrencyFull(holding.price)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Intraday</span>
                <span className={cn("font-medium", holding.day_change >= 0 ? "text-success" : "text-destructive")}>
                  {holding.day_change >= 0 ? "+" : ""}{formatCurrencyFull(holding.day_change)}
                  {" "}({holding.day_change >= 0 ? "+" : ""}{holding.day_change_pct.toFixed(2)}%)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Market Value</span>
                <span className="font-medium">{formatCurrency(holding.current_value)}</span>
              </div>

              {/* Shares — read-only when trade-managed, editable inline otherwise */}
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Shares</span>
                {!sharesEditable ? (
                  <span className="font-medium">
                    {holding.shares == null ? "—" : holding.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                  </span>
                ) : (
                  <input required type="number" step="any" value={form.shares}
                    onChange={(e) => set("shares", e.target.value)}
                    className="w-28 text-right bg-transparent border-b border-dashed border-border focus:outline-none focus:border-primary font-medium text-sm py-0" />
                )}
              </div>

              {/* Total cost basis — read-only when trade-managed, editable inline otherwise */}
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Cost Basis</span>
                {!sharesEditable ? (
                  <span className="font-medium">
                    {holding.cost_basis_total != null ? `$${Math.round(Number(holding.cost_basis_total)).toLocaleString()}` : "—"}
                  </span>
                ) : (
                  <input type="number" step="any" value={form.cost_basis_total}
                    onChange={(e) => set("cost_basis_total", e.target.value)}
                    className="w-28 text-right bg-transparent border-b border-dashed border-border focus:outline-none focus:border-primary font-medium text-sm py-0" />
                )}
              </div>

              <div className="flex justify-between">
                <span className="text-muted-foreground">Basis/Share</span>
                <span className="font-medium">
                  {(holding.shares ?? 0) > 0 && (holding.cost_basis_total ?? 0) > 0
                    ? formatCurrencyFull((holding.cost_basis_total as number) / holding.shares)
                    : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Total G/L</span>
                <span className={cn("font-medium", holding.total_gain == null ? "text-muted-foreground" : holding.total_gain >= 0 ? "text-success" : "text-destructive")}>
                  {holding.total_gain == null ? "—" : formatCurrency(holding.total_gain)}
                  {holding.total_gain_pct != null && ` (${holding.total_gain_pct.toFixed(2)}%)`}
                </span>
              </div>
              {isFund && (
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Expense Ratio</span>
                  {canFillExpenseRatio ? (
                    <span className="flex items-center gap-1">
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 0.03"
                        aria-label="Expense ratio (%)"
                        aria-invalid={expenseRatioError ? true : undefined}
                        value={form.expense_ratio}
                        onChange={(e) => set("expense_ratio", e.target.value.replace(/[^0-9.]/g, ""))}
                        className={cn(
                          "w-20 text-right bg-transparent border-b border-dashed border-border focus:outline-none focus:border-primary font-medium text-sm py-0 placeholder:text-muted-foreground/60",
                          expenseRatioError && "border-destructive",
                        )}
                      />
                      <span className="text-muted-foreground">%</span>
                    </span>
                  ) : (
                    <span className="font-medium">{holding.expense_ratio!.toFixed(2)}%</span>
                  )}
                </div>
              )}
            </div>
            {expenseRatioError && <p className="text-xs text-destructive">{expenseRatioError}</p>}
            {canFillExpenseRatio && !expenseRatioError && (
              <p className="text-xs text-muted-foreground">
                Paiso has no expense ratio for this fund. Add it from the fund&apos;s fact sheet so Fee Analysis can count it.
              </p>
            )}

            {/* Deep-dive toggle — expands inline rather than swapping views */}
            {holding.ticker && (
              <div className="rounded-md border border-border overflow-hidden">
                <button
                  type="button"
                  onClick={() => setDetailExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/40 transition-colors"
                >
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Maximize2 size={14} />
                    Deep Dive
                  </span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    price, ranges, news &amp; more
                    <ChevronDown size={14} className={cn("transition-transform", detailExpanded && "rotate-180")} />
                  </span>
                </button>
                {detailExpanded && (
                  <div className="border-t border-border px-3 py-3.5 bg-muted/10">
                    <TickerDetailView holding={holding} />
                  </div>
                )}
              </div>
            )}

            {/* Trade history — expands inline, same pattern as Deep Dive */}
            <div className="rounded-md border border-border overflow-hidden">
              <button
                type="button"
                onClick={() => setTradesExpanded((v) => !v)}
                className="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-muted/40 transition-colors"
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  <History size={14} />
                  Trade History
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={cn(
                    "text-xs px-2 py-0.5 rounded-full font-medium",
                    holding.has_trades
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  )}>
                    {holding.has_trades ? "active" : "none yet"}
                  </span>
                  <ChevronDown size={14} className={cn("transition-transform text-muted-foreground", tradesExpanded && "rotate-180")} />
                </span>
              </button>
              {tradesExpanded && (
                <div className="border-t border-border bg-muted/10">
                  <TradeHistoryView holding={holding} handleRef={pendingTrades} />
                </div>
              )}
            </div>

            <RowVisibilityFields
              hidden={form.hidden} onHidden={(v) => set("hidden", v)}
              excluded={form.exclude_from_net_worth} onExcluded={(v) => set("exclude_from_net_worth", v)}
              excludeHelp="This holding will not be counted in your net worth. It still counts in Investments." />

            {update.error && <p className="text-sm text-destructive">{(update.error as Error).message}</p>}
            <Button type="submit" loading={update.isPending || savingTrades} className="w-full">Save changes</Button>

            <hr className="border-border" />

            {confirmDelete ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive text-center">Delete {holding.ticker ?? holding.name}? This cannot be undone.</p>
                <div className="flex gap-2">
                  <Button type="button" variant="destructive" size="sm" className="flex-1" onClick={handleDelete} loading={deleteHolding.isPending}>
                    <AlertTriangle size={13} /> Confirm delete
                  </Button>
                  <Button type="button" variant="outline" size="sm" className="flex-1" onClick={() => setConfirmDelete(false)}>Cancel</Button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)}
                className="w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors">
                Delete holding
              </button>
            )}
          </form>
      )}
    </SideDrawer>
  );
}

// ── Stocks Page ───────────────────────────────────────────────────────────────

// Matches the server-side market-refresh cadence (app/workers/scheduler.py,
// 60s): polling
// faster just re-reads identical data, since prices only change once per minute.
const AUTO_REFRESH_INTERVAL = 60;

export function StocksPage() {
  const { data: holdings = [], isLoading } = useHoldings();
  const navigate = useNavigate();
  const refresh = useRefreshMarket();
  const refetchHoldings = useRefetchHoldings();
  const update = useUpdateHolding();

  // No blocking refresh on mount: holdings render immediately from the
  // server-warmed cache, and auto-refresh (below) keeps them current.

  // ── Refresh mode ──────────────────────────────────────────────────────────────
  type RefreshMode = "auto-market" | "manual";
  const [refreshMode, setRefreshMode] = useState<RefreshMode>("auto-market");
  const [countdown, setCountdown] = useState(AUTO_REFRESH_INTERVAL);
  const [marketOpen, setMarketOpen] = useState(() => isMarketOpen());
  const [refreshMenuOpen, setRefreshMenuOpen] = useState(false);
  const refetchRef = useRef(refetchHoldings);
  refetchRef.current = refetchHoldings;
  const refreshMenuRef = useRef<HTMLDivElement>(null);

  // Close refresh dropdown on outside click
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (refreshMenuRef.current && !refreshMenuRef.current.contains(e.target as Node))
        setRefreshMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  useEffect(() => {
    if (refreshMode !== "auto-market") {
      setCountdown(AUTO_REFRESH_INTERVAL);
      return;
    }
    setCountdown(AUTO_REFRESH_INTERVAL);
    const id = setInterval(() => {
      const open = isMarketOpen();
      setMarketOpen(open);
      setCountdown((c) => {
        if (c <= 1) {
          // Silent re-read of the server-warmed cache — no spinner, values just
          // swap in (keepPreviousData keeps the table visible meanwhile).
          if (open) refetchRef.current();
          return AUTO_REFRESH_INTERVAL;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [refreshMode]);

  const [showAdd, setShowAdd] = useState(false);
  const [addInitialTicker, setAddInitialTicker] = useState<string | undefined>(undefined);
  const [showLookup, setShowLookup] = useState(false);
  const [editHoldingId, setEditHoldingId] = useState<number | null>(null);
  const [balanceRow, setBalanceRow] = useState<RowItem | null>(null);
  // Rows the user hid from this table (ui_prefs.hiddenHoldingRows). They stay
  // in every total; "Show hidden" brings them back, dimmed.
  const hiddenRows = useUiPrefsStore((st) => st.hiddenHoldingRows);
  const hiddenRowSet = useMemo(() => new Set(hiddenRows), [hiddenRows]);
  const [showHidden, setShowHidden] = useState(false);

  function handleLookupAddToPortfolio(ticker: string) {
    setShowLookup(false);
    setAddInitialTicker(ticker);
    setShowAdd(true);
  }

  // Stocks & Funds is the tab for investing (and crypto) accounts. A 401(k)'s
  // VTI is on Retirement, a 529's on Education: each dollar has one home
  // tab, and the tabs add up to the Overview.
  const { data: allAccounts = [] } = useAccounts();
  const rows = useMemo(() => {
    const typeOf = new Map(allAccounts.map((a) => [a.id, a.investment_type ?? null]));
    return holdings
      .filter((h) => {
        if (!h.account_id) return false;
        const t = typeOf.get(h.account_id);
        return t == null || t === "investing";
      });
  }, [holdings, allAccounts]);
  const { data: incomeSummary } = useIncomeSummary(true);
  const [editInitialView, setEditInitialView] = useState<"main" | "trades">("main");
  const [freshHolding, setFreshHolding] = useState<Holding | null>(null);

  // Once the holdings cache has refreshed and contains the newly-created holding,
  // drop freshHolding so the edit drawer gets the fully-populated server data
  // (cost_basis_total, has_trades, shares are all correct only after cache refresh).
  useEffect(() => {
    if (freshHolding && holdings.some(h => h.id === freshHolding.id)) {
      setFreshHolding(null);
    }
  }, [holdings, freshHolding]);

  // Use freshHolding immediately after creation (before cache refresh), then fall back to list
  const editHolding = useMemo(() => {
    if (editHoldingId == null) return null;
    if (freshHolding?.id === editHoldingId) return freshHolding;
    return holdings.find((h) => h.id === editHoldingId) ?? null;
  }, [editHoldingId, freshHolding, holdings]);

  function handleCreated(h: Holding) {
    setFreshHolding(h);
    setEditHoldingId(h.id);
    setEditInitialView("main");
  }

  function handleEditClose() {
    setEditHoldingId(null);
    setFreshHolding(null);
    setEditInitialView("main");
  }

  // Sort is a remembered preference, not per-visit state: someone who reads
  // this table by day gain wants it that way tomorrow too. Stored with the
  // other UI prefs, so it follows the account across devices.
  const savedSort = useUiPrefsStore((s) => s.tableSort.holdings);
  const setTableSort = useUiPrefsStore((s) => s.setTableSort);
  const sortKey = (savedSort?.key ?? "current_value") as keyof Holding;
  const sortDir = savedSort?.dir ?? "desc";
  const setSort = (key: keyof Holding, dir: "asc" | "desc") =>
    setTableSort("holdings", { key: String(key), dir });
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  // `?account=12` opens the table on one account (the Overview links here).
  const [accountFilter, setAccountFilter] = useState<number | "">(() => {
    const id = Number(new URLSearchParams(window.location.search).get("account"));
    return Number.isFinite(id) && id > 0 ? id : "";
  });
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  // The phone's Options sheet: account filter, hidden rows, look-up, refresh.
  const [optionsOpen, setOptionsOpen] = useState(false);

  // Overlay state — lifted here so table rows can toggle overlays directly
  const [overlayTickers, setOverlayTickers] = useState<string[]>([]);
  const [isChartIntraday, setIsChartIntraday] = useState(false);

  function toggleOverlay(ticker: string) {
    setOverlayTickers((prev) =>
      prev.includes(ticker) ? prev.filter((t) => t !== ticker) : [...prev, ticker],
    );
  }

  function toggleSort(key: string) {
    if (sortKey === key) setSort(sortKey, sortDir === "asc" ? "desc" : "asc");
    else setSort(key as keyof Holding, "desc");
  }

  function toggleFavorite(e: React.MouseEvent, h: RowItem) {
    e.stopPropagation();
    update.mutate({ id: h.id, is_favorited: !h.is_favorited });
  }

  // Built from every kind of row the table shows, not just holdings, so an
  // account whose only row is its balance or "Other funds" can be picked.
  const uniqueAccounts = useMemo(() => {
    const seen = new Map<number, string>();
    rows.forEach((h) => { if (h.account_id && h.account_name) seen.set(h.account_id, h.account_name); });
    return Array.from(seen.entries()).map(([id, name]) => ({ id, name }));
  }, [rows]);

  const rowKey = (h: RowItem) => h.row_key ?? String(h.id);

  function openRow(h: RowItem) {
    if (h.kind === "balance") setBalanceRow(h);
    else if (h.kind === "other_funds") navigate("/settings?tab=accounts");
    else { setEditInitialView("main"); setFreshHolding(null); setEditHoldingId(h.id); }
  }

  const filtered = useMemo((): RowItem[] => {
    // Merge OPT rows before filtering and sorting so favorites and value-sort
    // are handled identically to regular holdings.
    let list: RowItem[] = [...rows];
    if (!showHidden) list = list.filter((h) => !hiddenRowSet.has(rowKey(h)));
    if (accountFilter !== "") list = list.filter((h) => h.account_id === accountFilter);
    if (search.trim()) {
      list = list.filter((h) => {
        const haystack = [h.ticker, h.name, h.account_name, h.type]
          .filter((v): v is string => typeof v === "string")
          .join(" ");
        return matchesSearch(haystack, search);
      });
    }
    list = list.sort((a, b) => {
      if (a.is_favorited !== b.is_favorited) return a.is_favorited ? -1 : 1;
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      const an = (av as number) ?? 0;
      const bn = (bv as number) ?? 0;
      return sortDir === "asc" ? an - bn : bn - an;
    });
    return list;
  }, [rows, accountFilter, search, sortKey, sortDir, showHidden, hiddenRowSet]); // eslint-disable-line react-hooks/exhaustive-deps
  const hiddenCount = rows.filter((h) => hiddenRowSet.has(rowKey(h))).length;

  // Security IDs from the currently filtered table → drives the trend chart
  // Filter out null (balance-backed accounts have no security)
  const filteredSecurityIds = useMemo(
    () => [...new Set(filtered.map((h) => h.security_id).filter((id): id is number => id != null))],
    [filtered],
  );
  const isFiltered = accountFilter !== "" || search.trim() !== "";
  // The chart covers this tab's accounts only, not a 401(k)'s VTI.
  const scopeAccountIds = useMemo(
    () => [...new Set(rows.map((r) => r.account_id).filter((id): id is number => !!id))],
    [rows],
  );

  // Unique tickers across all holdings (for overlay chips)
  const availableTickers = useMemo(() => {
    const seen = new Map<string, string>();
    holdings.forEach((h) => { if (h.ticker) seen.set(h.ticker, h.name); });
    return Array.from(seen.entries()).map(([ticker, name]) => ({ ticker, name }));
  }, [holdings]);

  // Every row the server sends, at market value. Excluding a row counts
  // against net worth only: without the excluded rows these add up to
  // the Dashboard's investment value, and the summary bar says how much
  // is excluded so the difference is explained.
  const chartHoldings = rows;
  const excludedValue = rows.filter((h) => h.exclude_from_net_worth).reduce((s, h) => s + h.current_value, 0);
  const totalValue    = chartHoldings.reduce((s, h) => s + h.current_value, 0);
  // Holdings with no recorded basis contribute no gain rather than poisoning
  // the total with NaN — or, worse, with their whole market value.
  const totalGain     = chartHoldings.reduce((s, h) => s + (h.total_gain ?? 0), 0);

  // Today's change for the chart headline. Scoped to whatever the chart is
  // actually drawing: filtering the table by account or search narrows the
  // chart via `filteredSecurityIds`, so summing every holding here would print
  // a portfolio-wide move above a single account's line.
  const chartScopeHoldings = (isFiltered ? filtered : rows).filter((h) => h.security_id != null);
  const chartDayGain  = chartScopeHoldings.reduce((s, h) => s + (h.day_gain ?? 0), 0);
  const chartDayValue = chartScopeHoldings.reduce((s, h) => s + h.current_value, 0);
  // Withheld until there is something to sum: handing the chart a 0 mid-fetch
  // would flash "+$0.00 (0.00%)" over a chart that is drawing real movement.
  const holdingsLoaded = !isLoading && chartScopeHoldings.length > 0;

  // ── Column order & drag state ──────────────────────────────────────────────
  const [colOrder, setColOrder] = useState<StockColKey[]>(loadStockColOrder);
  const [dragKey, setDragKey] = useState<StockColKey | null>(null);
  const [dropKey, setDropKey] = useState<StockColKey | null>(null);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  const [savedColDefault, setSavedColDefault] = useState<StockColKey[]>(
    () => loadSavedColDefault() ?? [...STOCK_COL_KEYS],
  );
  const [hiddenCols, setHiddenCols] = useState<StockColKey[]>(loadHiddenCols);
  const hiddenSet = useMemo(() => new Set(hiddenCols), [hiddenCols]);

  function toggleColVisible(key: StockColKey) {
    if (ALWAYS_VISIBLE_COLS.includes(key)) return;
    setHiddenCols((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      saveHiddenCols(next);
      return next;
    });
  }

  // Close col dropdown on outside click
  useEffect(() => {
    function handleOutside(e: MouseEvent) {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node))
        setColMenuOpen(false);
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  function handleColDrop(targetKey: StockColKey) {
    if (!dragKey || dragKey === targetKey) return;
    const next = [...colOrder];
    const fromIdx = next.indexOf(dragKey);
    const toIdx = next.indexOf(targetKey);
    next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
    setColOrder(next);
    saveStockColOrder(next);
  }
  function resetColOrder() {
    setColOrder([...savedColDefault]);
    saveStockColOrder(savedColDefault);
    setHiddenCols([...DEFAULT_HIDDEN_COLS]);
    saveHiddenCols(DEFAULT_HIDDEN_COLS);
    setColMenuOpen(false);
  }
  function saveCurrentColAsDefault() {
    saveSavedColDefault(colOrder);
    setSavedColDefault([...colOrder]);
    setColMenuOpen(false);
  }

  // Column definitions — defined inside render so they close over callbacks
  type ColDef = {
    key: StockColKey;
    label: string;
    left?: boolean;
    sortKey?: keyof Holding;
    tdCls?: string;
    renderCell: (h: RowItem) => React.ReactNode;
  };

  const colDefs: Record<StockColKey, ColDef> = {
    favorite: {
      key: "favorite",
      label: "",
      left: true,
      tdCls: "w-6",
      renderCell: (h) => (
        <button type="button" onClick={(e) => toggleFavorite(e, h)}
          className={cn("p-0.5 rounded transition-colors",
            h.is_favorited ? "text-amber-500 hover:text-amber-400" : "text-muted-foreground/50 hover:text-amber-500")}
          title={h.is_favorited ? "Remove from favorites" : "Add to favorites"}>
          <Star size={16} strokeWidth={2} className={h.is_favorited ? "fill-amber-400" : "fill-none"} />
        </button>
      ),
    },
    ticker: {
      key: "ticker",
      label: "Ticker",
      left: true,
      sortKey: "ticker",
      renderCell: (h) => {
        if (isSynthetic(h)) {
          // An "Other funds" value, an account balance, or a holding with no market
          // ticker: the name is the identifier, and the note says where the
          // price came from.
          const badge = h.kind ? KIND_BADGE[h.kind] : undefined;
          const note = priceSourceNote(h);
          return (
            <div className="group relative inline-flex items-center gap-1 max-w-[16rem]">
              <span className="truncate font-medium">{h.name}</span>
              {badge && (
                <span title={badge.title} className={cn("text-[10px] px-1.5 py-0.5 rounded font-mono shrink-0", badge.cls)}>
                  {badge.label}
                </span>
              )}
              {h.exclude_from_net_worth && <span title="Excluded from net worth"><EyeOff size={11} className="text-muted-foreground" /></span>}
              {(h.ticker || note) && (
                <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block bg-card border border-border rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg text-foreground">
                  {h.ticker && <span className="font-mono">{h.ticker}</span>}
                  {h.ticker && note && " · "}
                  {note}
                </div>
              )}
            </div>
          );
        }
        const isActive = h.ticker != null && overlayTickers.includes(h.ticker);
        const overlayColor = isActive
          ? OVERLAY_COLORS[overlayTickers.indexOf(h.ticker!) % OVERLAY_COLORS.length]
          : undefined;
        return (
          <div className="group relative inline-flex items-center gap-1">
            {h.ticker && (
              <OverlayToggleButton
                ticker={h.ticker}
                isActive={isActive}
                overlayColor={overlayColor}
                isChartIntraday={isChartIntraday}
                onToggle={(e) => { e.stopPropagation(); toggleOverlay(h.ticker!); }}
              />
            )}
            <span className="font-mono font-medium text-primary">{h.ticker ?? "—"}</span>
            {h.exclude_from_net_worth && <span title="Excluded from net worth"><EyeOff size={11} className="text-muted-foreground" /></span>}
            {h.has_trades && <span title="Has trade history"><History size={11} className="text-muted-foreground" /></span>}
            {h.name && (
              <div className="absolute left-0 top-full mt-1 z-10 hidden group-hover:block bg-card border border-border rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap shadow-lg text-foreground">
                {h.name}
              </div>
            )}
          </div>
        );
      },
    },
    account: {
      key: "account",
      label: "Account",
      left: true,
      renderCell: (h) => (
        <span title={h.account_name ?? undefined} className="block max-w-[12rem] truncate text-muted-foreground" data-private>{h.account_name}</span>
      ),
    },
    shares: {
      key: "shares",
      label: "Shares",
      sortKey: "shares",
      renderCell: (h) => h.shares == null
        ? <span className="text-muted-foreground">—</span>
        : <span className="tabular-nums">{h.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>,
    },
    price: {
      key: "price",
      label: "Price",
      sortKey: "price",
      renderCell: (h) => {
        if (h.price == null) return <span className="text-muted-foreground">—</span>;
        const note = h.price_source && h.price_source !== "live" ? priceSourceNote(h) : null;
        return (
          <span className="tabular-nums" title={note ?? undefined}>
            {formatCurrencyFull(h.price)}
            {note && <span className="block text-[10px] text-muted-foreground leading-tight">{note}</span>}
          </span>
        );
      },
    },
    day_change: {
      key: "day_change",
      label: "Intraday Chg",
      sortKey: "day_change",
      renderCell: (h) => isSynthetic(h) ? <span className="text-muted-foreground">—</span> : (
        <span
          className={cn("tabular-nums", h.day_change >= 0 ? "text-success" : "text-destructive")}
          // When the market is closed this is the last session's move, not
          // today's — say so on hover rather than in the cramped cell.
          title={`Change for ${sessionSuffix(h.day_change_session)}`}
        >
          {h.day_change >= 0 ? "+" : ""}{formatCurrencyFull(h.day_change)}
          <span className="text-xs ml-1">({h.day_change >= 0 ? "+" : ""}{h.day_change_pct.toFixed(2)}%)</span>
        </span>
      ),
    },
    day_range: {
      key: "day_range",
      label: "Today's Range",
      tdCls: "w-36",
      renderCell: (h) => isSynthetic(h) ? <span className="text-muted-foreground">—</span> : (
        <MiniRangeScale low={h.day_low} high={h.day_high} value={h.price} />
      ),
    },
    week52_range: {
      key: "week52_range",
      label: "52-Week Range",
      tdCls: "w-36",
      renderCell: (h) => isSynthetic(h) ? <span className="text-muted-foreground">—</span> : (
        <MiniRangeScale low={h.week52_low} high={h.week52_high} value={h.price} />
      ),
    },
    current_value: {
      key: "current_value",
      label: "Value",
      sortKey: "current_value",
      tdCls: "font-medium",
      renderCell: (h) => <span className="tabular-nums">
        {formatCurrency(h.current_value)}</span>,
    },
    day_gain: {
      key: "day_gain",
      label: "Day G/L",
      sortKey: "day_gain",
      renderCell: (h) => isSynthetic(h) || h.day_gain == null ? <span className="tabular-nums text-muted-foreground">—</span> : (
        <span className={cn("tabular-nums", h.day_gain >= 0 ? "text-success" : "text-destructive")}>
          {formatCurrency(h.day_gain)}
        </span>
      ),
    },
    cost_basis: {
      key: "cost_basis",
      label: "Cost Basis",
      sortKey: "cost_basis_total",
      renderCell: (h) => isSynthetic(h) ? <span className="tabular-nums text-muted-foreground">—</span> : (
        <span className="tabular-nums text-muted-foreground">
          {(h.cost_basis_total ?? 0) > 0 ? formatCurrency(h.cost_basis_total as number) : "—"}
        </span>
      ),
    },
    basis_per_share: {
      key: "basis_per_share",
      label: "Basis/Share",
      sortKey: "cost_basis_total",
      renderCell: (h) => {
        const bps = (h.shares ?? 0) > 0 && (h.cost_basis_total ?? 0) > 0
          ? (h.cost_basis_total as number) / h.shares
          : null;
        return (
          <span className="tabular-nums text-muted-foreground">
            {bps != null ? formatCurrencyFull(bps) : "—"}
          </span>
        );
      },
    },
    total_gain: {
      key: "total_gain",
      label: "Total G/L",
      sortKey: "total_gain",
      // Blank when the basis is unknown. Gain is value minus cost, and without
      // a cost there is no gain to state — showing the value itself claimed a
      // $4,000 profit on a position whose cost had simply never been entered.
      renderCell: (h) => h.total_gain == null ? (
        <span
          className="tabular-nums text-muted-foreground"
          title="Add the purchase price to your trade history to see gain or loss."
        >
          —
        </span>
      ) : (
        <span className={cn("tabular-nums", h.total_gain >= 0 ? "text-success" : "text-destructive")}>
          {formatCurrency(h.total_gain)}
        </span>
      ),
    },
    return_pct: {
      key: "return_pct",
      label: "Return %",
      sortKey: "total_gain_pct",
      renderCell: (h) => isSynthetic(h) ? <span className="tabular-nums text-muted-foreground">—</span> : (
        <span className={cn("tabular-nums", (h.total_gain_pct ?? 0) >= 0 ? "text-success" : "text-destructive")}>
          {h.total_gain_pct != null ? `${h.total_gain_pct.toFixed(2)}%` : "—"}
        </span>
      ),
    },
  };

  const orderedCols = colOrder
    .map((k) => colDefs[k])
    .filter((c) => c && !hiddenSet.has(c.key));
  const dragIdx = colOrder.indexOf(dragKey ?? ("" as StockColKey));
  const dropIdx = colOrder.indexOf(dropKey ?? ("" as StockColKey));

  return (
    <div className="space-y-4">
      <PortfolioTrendChart
        accountId={accountFilter !== "" ? accountFilter : undefined}
        securityIds={isFiltered ? filteredSecurityIds : undefined}
        accountIds={scopeAccountIds}
        availableTickers={availableTickers}
        overlayTickers={overlayTickers}
        onToggleOverlay={toggleOverlay}
        onClearOverlays={() => setOverlayTickers([])}
        onIntradayChange={setIsChartIntraday}
        dayGain={holdingsLoaded ? chartDayGain : undefined}
        dayValue={holdingsLoaded ? chartDayValue : undefined}
      />

      {/* Summary + actions bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span>Market Value: <strong>{formatCurrency(totalValue)}</strong>
            {excludedValue >= 0.005 && <span className="text-muted-foreground"> ({formatCurrency(excludedValue)} excluded from net worth)</span>}
          </span>
          <span className={cn(totalGain >= 0 ? "text-success" : "text-destructive")}>Total G/L: {formatCurrency(totalGain)}</span>
          {/* "Today" lives once, in the chart header above. It used to be
              repeated here from a different source — the chart measured from
              the session's first bar while this read live quotes — so the two
              printed different dollar figures for the same day, inches apart. */}
          {incomeSummary && (incomeSummary.year_total > 0 || incomeSummary.projected_annual > 0) && (
            <span className="flex items-center gap-1 text-primary">
              Income YTD: {formatCurrency(incomeSummary.ytd_total ?? incomeSummary.year_total)}
              {incomeSummary.projected_annual > 0 && (
                <span className="text-muted-foreground">
                  (proj. {formatCurrency(incomeSummary.projected_annual)}/yr)
                </span>
              )}
              <InfoTooltip text="Dividends, reinvestments, interest and capital-gain distributions recorded in trade history this year. Projection = Σ dividend yield × position value across holdings. Yields come from public market data, are best effort, and can be wrong." />
            </span>
          )}
        </div>
        {/* On a phone these actions live in the Options sheet and the "+"
            button beside the search, so the holdings start higher. */}
        {isMobile ? (
          refreshMode === "auto-market" && marketOpen && (
            <p className="w-full flex items-center gap-1.5 text-xs text-success">
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" /> Live · {countdown}s
            </p>
          )
        ) : (
        <div className="flex flex-wrap gap-2 items-center justify-end">
          {/* Combined refresh control: refresh now, or choose the mode. */}
                    <div ref={refreshMenuRef} className="relative flex items-center">
            <div className={cn(
              "flex items-center rounded-md border overflow-hidden text-xs font-medium select-none",
              refreshMode === "auto-market" && marketOpen ? "border-success/40" : "border-border",
            )}>
              <button
                onClick={() => refresh.mutate()}
                disabled={refresh.isPending}
                title="Refresh now"
                className={cn(
                  "flex items-center gap-1.5 px-3 h-8 transition-colors",
                  refreshMode === "auto-market" && marketOpen
                    ? "bg-success/10 text-success hover:bg-success/20"
                    : "bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {refresh.isPending ? (
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : refreshMode === "auto-market" ? (
                  marketOpen ? (
                    <>
                      <span className="relative flex h-1.5 w-1.5 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success opacity-75" />
                        <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-success" />
                      </span>
                      Live · {countdown}s
                    </>
                  ) : (
                    <><RefreshCw size={12} /> Mkt closed</>
                  )
                ) : (
                  <><RefreshCw size={12} /> Refresh</>
                )}
              </button>
              <button
                onClick={() => setRefreshMenuOpen((v) => !v)}
                className={cn(
                  "border-l px-2 h-8 transition-colors",
                  refreshMode === "auto-market" && marketOpen
                    ? "border-success/30 text-success hover:bg-success/20"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/40",
                )}
              >
                <ChevronDown size={12} />
              </button>
            </div>
            {refreshMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 rounded-md border border-border bg-card shadow-lg z-20 py-1">
                <button
                  onClick={() => { setRefreshMode("auto-market"); setRefreshMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                >
                  <span>
                    <span className="font-medium block">Auto (market hours)</span>
                    <span className="text-muted-foreground">Every 30s, 9:30 AM – 4 PM ET</span>
                  </span>
                  {refreshMode === "auto-market" && <span className="text-primary ml-2">✓</span>}
                </button>
                <button
                  onClick={() => { setRefreshMode("manual"); setRefreshMenuOpen(false); }}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-muted/50 transition-colors text-left"
                >
                  <span>
                    <span className="font-medium block">Manual</span>
                    <span className="text-muted-foreground">Refresh only when you click</span>
                  </span>
                  {refreshMode === "manual" && <span className="text-primary ml-2">✓</span>}
                </button>
              </div>
            )}
          </div>
          <FeatureTip
            id="ticker-deep-dive"
            title="Deep-dive any ticker"
            placement="bottom-end"
          >
            Use <span className="font-medium">Look up ticker</span> to search any
            stock, ETF or fund, including ones you do not hold, and see price ranges,
            fundamentals, analyst consensus and news.
          </FeatureTip>
          <Button size="sm" variant="outline" onClick={() => setShowLookup(true)}>
            <Search size={13} /> Look up ticker
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus size={13} /> Add holding
          </Button>

        </div>
        )}
      </div>

      {/* Search + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {isMobile && !mobileSearchOpen && !search ? (
          <button
            type="button"
            onClick={() => setMobileSearchOpen(true)}
            className="flex items-center justify-center h-9 w-9 shrink-0 rounded-md border border-border bg-background text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Search holdings"
          >
            <Search size={15} />
          </button>
        ) : (
          <div className="flex items-center flex-1 min-w-[180px] rounded-md border border-border bg-background px-3 gap-2">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input type="text" placeholder="Search…" value={search}
              autoFocus={isMobile && mobileSearchOpen}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 py-1.5 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground min-w-0" />
            {(search || (isMobile && mobileSearchOpen)) && (
              <button onClick={() => { setSearch(""); setMobileSearchOpen(false); }} className="text-muted-foreground hover:text-foreground shrink-0">
                <X size={13} />
              </button>
            )}
          </div>
        )}
        {uniqueAccounts.length > 1 && !isMobile && (
          <AccountFilterSelect
            value={accountFilter}
            onChange={(id) => setAccountFilter(id ?? "")}
            accounts={uniqueAccounts}
            // A phone: beside the search icon instead of on a row of its own,
            // and wide enough that the sort control wraps below it.
            className={cn(isMobile && "w-auto flex-1 min-w-[55%] min-h-[40px]")}
          />
        )}
        {/* Sort control on mobile, moved up from the card list below.
            It shares one row with the search icon, Options and "+". */}
        {isMobile && !mobileSearchOpen && (
          <select
            value={`${String(sortKey)}-${sortDir}`}
            onChange={(e) => {
              const i = e.target.value.lastIndexOf("-");
              setSort(
                e.target.value.slice(0, i) as keyof Holding,
                e.target.value.slice(i + 1) as "asc" | "desc",
              );
            }}
            className={cn(
              "flex-1 min-w-0 rounded-md border border-border bg-background px-3 py-1.5 min-h-[40px] text-sm focus:outline-none focus:ring-2 focus:ring-primary/50",
            )}
          >
            <option value="current_value-desc">Largest value</option>
            <option value="day_gain-desc">Best day G/L</option>
            <option value="day_gain-asc">Worst day G/L</option>
            <option value="total_gain-desc">Best total G/L</option>
            <option value="ticker-asc">Ticker A–Z</option>
          </select>
        )}
        {isMobile && !mobileSearchOpen && (
          <>
            <Popover
              open={optionsOpen}
              onOpenChange={setOptionsOpen}
              label="Holdings options"
              trigger={
                <button
                  type="button"
                  onClick={() => setOptionsOpen((o) => !o)}
                  aria-label={`Options${accountFilter !== "" || showHidden ? ", a filter is on" : ""}`}
                  className="relative flex items-center justify-center h-10 w-10 shrink-0 rounded-md border border-border bg-background text-muted-foreground"
                >
                  <SlidersHorizontal size={16} />
                  {(accountFilter !== "" || showHidden) && (
                    <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" aria-hidden />
                  )}
                </button>
              }
            >
              <div className="space-y-3">
                <button type="button" onClick={() => { setOptionsOpen(false); setShowLookup(true); }}
                  className="flex w-full min-h-[44px] items-center gap-2 rounded-md border border-border px-3 text-sm">
                  <Search size={15} /> Look up ticker
                </button>
                {uniqueAccounts.length > 1 && (
                  <AccountFilterSelect
                    value={accountFilter}
                    onChange={(id) => setAccountFilter(id ?? "")}
                    accounts={uniqueAccounts}
                    className="w-full min-h-[44px]"
                  />
                )}
                {hiddenCount > 0 && (
                  <button type="button" onClick={() => setShowHidden((v) => !v)}
                    className="flex w-full min-h-[44px] items-center gap-2 rounded-md border border-border px-3 text-sm">
                    {showHidden ? <><EyeOff size={15} /> Hide hidden rows</> : <><Eye size={15} /> Show hidden rows ({hiddenCount})</>}
                  </button>
                )}
                                  <div className="space-y-1.5">
                    <button type="button" onClick={() => refresh.mutate()} disabled={refresh.isPending}
                      className="flex w-full min-h-[44px] items-center gap-2 rounded-md border border-border px-3 text-sm disabled:opacity-50">
                      <RefreshCw size={15} /> {refresh.isPending ? "Refreshing…" : "Refresh prices now"}
                    </button>
                    <div className="flex gap-1.5">
                      {([["auto-market", "Auto in market hours"], ["manual", "Manual"]] as const).map(([mode, text]) => (
                        <button key={mode} type="button" onClick={() => setRefreshMode(mode)} aria-pressed={refreshMode === mode}
                          className={cn(
                            "flex-1 min-h-[44px] rounded-md border px-2 text-xs",
                            refreshMode === mode ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                          )}>
                          {text}
                        </button>
                      ))}
                    </div>
                  </div>
              </div>
            </Popover>
            <button type="button" onClick={() => setShowAdd(true)} aria-label="Add holding"
              className="flex items-center justify-center h-10 w-10 shrink-0 rounded-full bg-primary text-primary-foreground">
              <Plus size={18} />
            </button>
          </>
        )}
        {hiddenCount > 0 && !isMobile && (
          <button
            onClick={() => setShowHidden((v) => !v)}
            className={cn(
              "flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors",
              isMobile && "min-h-[40px]",
            )}
            title={showHidden ? "Take hidden rows out of the table again" : "Show the rows you hid"}
          >
            {showHidden ? <><EyeOff size={12} /> Hide hidden</> : <><Eye size={12} /> Show hidden ({hiddenCount})</>}
          </button>
        )}
        {showHidden && hiddenCount > 0 && (
          <p className="basis-full order-last text-xs text-muted-foreground">Hidden rows are dimmed. Open one and untick “Hide from table” to put it back.</p>
        )}
        {/* Column picker only applies to the desktop table — the mobile card
            list has its own fixed layout, so there's nothing for it to toggle. */}
        {!isMobile && (
          <div ref={colMenuRef} className="relative">
            <button
              onClick={() => setColMenuOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="Show, hide and reorder table columns"
            >
              <SlidersHorizontal size={12} /> Columns <ChevronDown size={10} />
            </button>
            {colMenuOpen && (
              <div className="absolute right-0 top-full mt-1 w-56 rounded-md border border-border bg-card shadow-lg z-20 py-1">
                <p className="px-3 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Visible columns
                </p>
                <div className="max-h-64 overflow-y-auto">
                  {colOrder.map((key) => {
                    const def = colDefs[key];
                    if (!def) return null;
                    const locked = ALWAYS_VISIBLE_COLS.includes(key);
                    const visible = !hiddenSet.has(key);
                    const label = key === "favorite" ? "Favorite" : def.label;
                    return (
                      <label
                        key={key}
                        className={cn(
                          "flex items-center gap-2 px-3 py-1.5 text-xs transition-colors",
                          locked ? "text-muted-foreground/60 cursor-default" : "hover:bg-muted/50 cursor-pointer",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={visible}
                          disabled={locked}
                          onChange={() => toggleColVisible(key)}
                          className="accent-primary"
                        />
                        <span>{label}</span>
                      </label>
                    );
                  })}
                </div>
                <div className="border-t border-border mt-1 pt-1">
                  <button
                    onClick={resetColOrder}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
                  >
                    Reset to default
                  </button>
                  <button
                    onClick={saveCurrentColAsDefault}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 transition-colors"
                  >
                    Save current as default
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Holdings — mobile card list (<md) */}
      <div className="md:hidden space-y-2">
        {isLoading ? (
          [...Array(5)].map((_, i) => <div key={i} className="h-20 rounded-lg bg-muted animate-pulse" />)
        ) : filtered.length === 0 ? (
          <div className="rounded-xl border border-border bg-card px-4 py-10 text-center text-muted-foreground text-sm">
            {rows.length === 0 ? "No holdings yet. Add your first holding above." : "No results match your search."}
          </div>
        ) : (
          filtered.map((h) => (
            <div
              key={rowKey(h)}
              onClick={() => openRow(h)}
              className={cn(
                "rounded-lg border border-border bg-card p-3 cursor-pointer active:bg-muted/30 transition-colors",
                (h.exclude_from_net_worth || hiddenRowSet.has(rowKey(h))) && "opacity-60",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                  <span className="min-w-0 truncate font-mono font-medium text-primary">
                    {h.ticker ?? "—"}
                  </span>
                  {h.exclude_from_net_worth && <EyeOff size={11} className="text-muted-foreground shrink-0" />}
                </span>
                <span className="tabular-nums font-medium shrink-0">
                  {formatCurrency(h.current_value)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 mt-0.5 text-xs">
                <span className="text-muted-foreground truncate">
                  {[
                    h.account_name,
                    h.shares != null && h.price != null
                      ? `${h.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })} @ ${formatCurrencyFull(h.price)}`
                      : null,
                    h.price_source && h.price_source !== "live" ? priceSourceNote(h) : null,
                  ].filter(Boolean).join(" · ")}
                </span>
                {!isSynthetic(h) && (
                  <span className={cn("tabular-nums shrink-0", h.day_change >= 0 ? "text-success" : "text-destructive")}>
                    {h.day_change >= 0 ? "+" : ""}{h.day_change_pct.toFixed(2)}% {sessionSuffix(h.day_change_session)}
                  </span>
                )}
              </div>
              {!isSynthetic(h) && (
                <div className="flex items-center justify-between gap-3 mt-1 text-xs">
                  <span className="text-muted-foreground">
                    Total G/L{" "}
                    <span className={cn("tabular-nums", h.total_gain == null ? "text-muted-foreground" : h.total_gain >= 0 ? "text-success" : "text-destructive")}>
                      {h.total_gain == null ? "—" : formatCurrency(h.total_gain)}
                      {h.total_gain_pct != null && ` (${h.total_gain_pct.toFixed(2)}%)`}
                    </span>
                  </span>
                  {h.day_gain != null && (
                    <span className={cn("tabular-nums", h.day_gain >= 0 ? "text-success" : "text-destructive")}>
                      {formatCurrency(h.day_gain)} {sessionSuffix(h.day_change_session)}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Holdings table (md+) */}
      <div className="hidden md:block rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted border-b border-border">
              <tr>
                {orderedCols.map((col) => {
                  const isDragging = dragKey === col.key;
                  const isTarget = dropKey === col.key && dragKey !== col.key;
                  const insertBefore = isTarget && dropIdx > dragIdx;
                  return (
                    <th
                      key={col.key}
                      draggable={col.key !== "favorite"}
                      onDragStart={() => setDragKey(col.key)}
                      onDragOver={(e) => { e.preventDefault(); setDropKey(col.key); }}
                      onDragEnd={() => { setDragKey(null); setDropKey(null); }}
                      onDrop={() => handleColDrop(col.key)}
                      onClick={() => col.sortKey && toggleSort(String(col.sortKey))}
                      title={col.key !== "favorite" ? "Drag to reorder" : undefined}
                      className={cn(
                        "px-3 py-2.5 font-medium text-muted-foreground select-none whitespace-nowrap transition-colors",
                        col.left ? "text-left" : "text-right",
                        col.sortKey && "cursor-pointer hover:text-foreground",
                        col.key !== "favorite" && !col.sortKey && "cursor-grab hover:text-foreground",
                        isDragging && "opacity-40",
                        isTarget && "bg-primary/10",
                        isTarget && insertBefore && "border-l-2 border-l-primary",
                        isTarget && !insertBefore && "border-r-2 border-r-primary",
                      )}
                    >
                      {col.label}
                      {col.sortKey && sortKey === String(col.sortKey) ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {isLoading
                ? [...Array(5)].map((_, i) => (
                    <tr key={i}>
                      {orderedCols.map((col) => (
                        <td key={col.key} className="px-3 py-3">
                          <div className="h-4 rounded bg-muted animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))
                : filtered.length === 0
                ? (
                    <tr><td colSpan={orderedCols.length} className="px-4 py-10 text-center text-muted-foreground">
                      {rows.length === 0 ? "No holdings yet. Add your first holding above." : "No results match your search."}
                    </td></tr>
                  )
                : filtered.map((h) => (
                    <tr key={rowKey(h)}
                      title={hiddenRowSet.has(rowKey(h)) ? "Hidden from this table. Open it to show it again." : undefined}
                      className={cn("hover:bg-muted/30 transition-colors cursor-pointer",
                        (h.exclude_from_net_worth || hiddenRowSet.has(rowKey(h))) && "opacity-60")}
                      onClick={() => openRow(h)}>
                      {orderedCols.map((col) => (
                        <td key={col.key}
                          className={cn(
                            "px-3 py-2.5",
                            col.left ? "text-left" : "text-right",
                            col.tdCls,
                          )}>
                          {col.renderCell(h)}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      <AddHoldingDrawer
        open={showAdd}
        onClose={() => { setShowAdd(false); setAddInitialTicker(undefined); }}
        onCreated={handleCreated}
        initialTicker={addInitialTicker}
      />
      <EditHoldingDrawer holding={editHolding} onClose={handleEditClose} initialView={editInitialView} />
      <BalanceRowDrawer row={balanceRow} onClose={() => setBalanceRow(null)} />
      <TickerLookupDrawer
        open={showLookup}
        onClose={() => setShowLookup(false)}
        onAddToPortfolio={handleLookupAddToPortfolio}
      />
    </div>
  );
}

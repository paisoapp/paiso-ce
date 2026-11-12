import { useEffect, useMemo, useState } from "react";
import { CHART_VIEW_ICONS } from "@/components/ui/ChartViewIcons";
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis, type TooltipProps,
} from "recharts";
import { useNetWorthIntraday, useNetWorthTrend, type NetWorthPoint } from "@/hooks/usePortfolio";
import { formatCurrency, cn } from "@/lib/utils";
import { DateRangePicker, todayISO } from "@/components/ui/DateRangePicker";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import type { DateRangeSection } from "@/store/uiPrefs";
import { CardTitle, clickableCardClass } from "@/components/ui/card-link";
import { useCardClick } from "@/lib/navTargets";
import { dateTickCount, evenTicks, formatAxisMoney, niceScale, moneyAxisFor } from "@/lib/chartTicks";
import { formatAxisDate, formatDate, formatMonthShort, formatShortDate, spanInDays } from "@/lib/dates";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { usePersistedState } from "@/hooks/usePersistedState";
import { useDragZoom } from "@/hooks/useDragZoom";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";
import { NetWorthSankey } from "./NetWorthSankey";

// ── Series ───────────────────────────────────────────────────────────────────

type TrendSeriesKey = "net_worth" | "total_assets" | "total_liabilities";

const UP = "#22c55e";
const DOWN = "#ef4444";

// Net worth takes its colour from its direction, as it always has. The other
// two get fixed hues that are neither green nor red, so a rising liabilities
// line is not read as good news and nothing is mistaken for the net worth line.
const SERIES: { key: TrendSeriesKey; label: string; color?: string; upIsGood: boolean }[] = [
  { key: "net_worth", label: "Net worth", upIsGood: true },
  { key: "total_assets", label: "Assets", color: "#3b82f6", upIsGood: true },
  { key: "total_liabilities", label: "Liabilities", color: "#f59e0b", upIsGood: false },
];

// ── Chart type ───────────────────────────────────────────────────────────────

type TrendChartType = "line" | "bar" | "sankey";
const CHART_TYPES: { value: TrendChartType; label: string; icon: (typeof CHART_VIEW_ICONS)[keyof typeof CHART_VIEW_ICONS] }[] = [
  { value: "line", label: "Trend", icon: CHART_VIEW_ICONS.trend },
  { value: "bar", label: "Bars", icon: CHART_VIEW_ICONS.bars },
  { value: "sankey", label: "Sankey", icon: CHART_VIEW_ICONS.sankey },
];

interface BarRow {
  date: string;
  label: string;
  net_worth: number;
  total_assets: number;
  /** Liabilities as a negative, so their bar hangs below the zero line. */
  owed: number;
}

/** The trend as one bar per day, week or month, whichever the range can hold.
 *  These are balances and not flows, so a bucket is its last day's figures and
 *  never a sum. Same thresholds as the Cash Flow bars. */
function bucketBalances(series: NetWorthPoint[]): BarRow[] {
  if (!series.length) return [];
  const day = (iso: string) => new Date(iso + "T12:00:00");
  const span = (day(series[series.length - 1].date).getTime() - day(series[0].date).getTime()) / 86_400_000;
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const keyOf = (date: string) => {
    if (span <= 31) return date;
    if (span > 90) return date.slice(0, 7);
    const d = day(date);
    d.setDate(d.getDate() + (d.getDay() === 0 ? -6 : 1 - d.getDay())); // back to Monday
    return iso(d);
  };
  const last = new Map<string, NetWorthPoint>();
  for (const pt of series) last.set(keyOf(pt.date), pt); // the series is in date order
  return [...last.entries()].map(([key, pt]) => {
    return {
      date: pt.date,
      label: key.length === 7 ? formatMonthShort(key) : formatShortDate(key),
      net_worth: pt.net_worth,
      total_assets: pt.total_assets,
      owed: -pt.total_liabilities,
    };
  });
}

/** Which lines are switched off, remembered per chart on this device. */
function useHiddenSeries(prefsKey: string, initial: TrendSeriesKey[]) {
  const storageKey = `paiso.networthTrend.hidden.${prefsKey}`;
  const [hidden, setHidden] = useState<Set<TrendSeriesKey>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const known = (JSON.parse(raw) as string[]).filter((k): k is TrendSeriesKey => SERIES.some((s) => s.key === k));
        // A stored set that hides everything would leave an empty chart.
        if (known.length < SERIES.length) return new Set(known);
      }
    } catch { /* fall through to the default */ }
    return new Set(initial);
  });
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify([...hidden])); } catch { /* private mode, quota */ }
  }, [storageKey, hidden]);
  const toggle = (key: TrendSeriesKey) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      // The last visible line stays: an empty chart is not a useful state.
      else if (next.size < SERIES.length - 1) next.add(key);
      return next;
    });
  return [hidden, toggle] as const;
}

// ── Net Worth Trend Chart ─────────────────────────────────────────────────────

/** Net worth, total assets and total liabilities over a chosen range, as $ or
 *  % change. Shared by the Portfolio page and the Dashboard widgets, each of
 *  which remembers its own range (`rangeSection`) and its own set of lines
 *  (`prefsKey`). Any line can be switched off from the legend.
 *
 *  It also draws as bars: assets above the zero line, liabilities below it,
 *  and net worth as a line across them, which shows what the figure is made
 *  of at each point where the lines only show where it went.
 *
 *  The third view, the Sankey, is today's position and not a trend: each
 *  kind of asset flowing into what is owed and what is left. It has no range,
 *  so the range picker and the change over the range step aside for it. */
export function NetWorthTrendChart({
  className,
  height = 200,
  to,
  rangeSection = "portfolio",
  title = "Net Worth Trend",
  prefsKey = rangeSection,
  defaultHidden = [],
  chart,
}: {
  className?: string;
  height?: number;
  to?: string;
  rangeSection?: DateRangeSection;
  title?: string;
  prefsKey?: string;
  /** Lines that start switched off, until the user says otherwise. */
  defaultHidden?: TrendSeriesKey[];
  /** Fixes the chart type and takes the switch away, for a widget that is
   *  one or the other. Left out, the user chooses and the choice is kept. */
  chart?: TrendChartType;
}) {
  const onCardClick = useCardClick(to);
  const isMobile = useIsMobile();
  const { dateRange, setDateRange } = useSectionDateRange(rangeSection);
  const [viewMode, setViewMode] = useState<"dollar" | "pct">("dollar");
  const [hidden, toggleSeries] = useHiddenSeries(prefsKey, defaultHidden);
  const [chosenChart, setChosenChart] = usePersistedState<TrendChartType>(
    `paiso.networth.chart.${prefsKey}`, "line", CHART_TYPES.map((t) => t.value),
  );
  const chartType = chart ?? chosenChart;
  const { data, isLoading: dailyLoading } = useNetWorthTrend(dateRange?.from, dateRange?.to);
  // "Today" on the trend view draws the latest market session: one daily
  // point was a single dot. The bars stay daily.
  const todayOnly = !!dateRange && dateRange.from === dateRange.to && dateRange.to === todayISO();
  const intradayWanted = todayOnly && chartType === "line";
  const { data: intraday, isLoading: intradayLoading } = useNetWorthIntraday(intradayWanted);
  const isIntraday = intradayWanted && (intraday?.series.length ?? 0) > 1;
  const isLoading = intradayWanted ? intradayLoading : dailyLoading;
  const series = useMemo(
    () => (isIntraday ? (intraday!.series as NetWorthPoint[]) : data?.series ?? []),
    [isIntraday, intraday, data?.series],
  );
  const session = isIntraday ? intraday?.session : null;
  // Drag across the trend to zoom into those dates. Not on the bars,
  // whose axis is labels, nor within one day.
  const zoom = useDragZoom({ range: dateRange, setRange: setDateRange, enabled: chartType === "line" && !isIntraday });
  const fmtTime = (d: string) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hasData = series.length > 0;
  const first = series[0];
  const last = series[series.length - 1];

  const firstVal = first?.net_worth ?? 0;
  const lastVal  = last?.net_worth ?? 0;
  const gain     = lastVal - firstVal;
  // A change from zero or from a negative net worth has no meaningful
  // percentage: it read "+0.00%" and, from a few dollars, "+25000.00%".
  // Only the dollar change is shown then.
  const gainPct  = firstVal > 0 ? (gain / firstVal) * 100 : null;
  const isPositive = gain >= 0;
  const netWorthColor = isPositive ? UP : DOWN;
  const visible = SERIES.filter((s) => !hidden.has(s.key));

  // What the chart plots. In % mode each line is its own change since the
  // start of the range, so three figures of very different sizes share one
  // axis. A line that starts at zero has no percentage change to show and is
  // left out — liabilities for someone who had none on the first day, say.
  const rows = useMemo(() => {
    if (viewMode === "dollar" || !first) return series;
    return series.map((pt) => {
      const row: { date: string } & Partial<Record<TrendSeriesKey, number>> = { date: pt.date };
      for (const s of SERIES) {
        const base = first[s.key];
        if (base > 0) row[s.key] = ((pt[s.key] - base) / base) * 100;
      }
      return row;
    });
  }, [series, viewMode, first]);

  // One domain across the visible lines, with a little headroom.
  // Round, evenly spaced value ticks: see niceScale in lib/chartTicks.
  const yScale = useMemo(() => {
    const vals = rows.flatMap((r) =>
      visible.map((s) => r[s.key]).filter((v): v is number => typeof v === "number"),
    );
    return niceScale(vals, { target: 5 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, viewMode, hidden]);
  const domain: [number, number] = yScale?.domain ?? (viewMode === "pct" ? [-1, 1] : [0, 1]);
  const pctDigits = yScale && yScale.step < 1 ? (yScale.step < 0.1 ? 2 : 1) : 0;

  // Explicit, evenly-spaced date ticks — see lib/chartTicks. Recharts' own
  // `preserveStartEnd` left a ragged gap at the right-hand end of the axis.
  const ticks = useMemo(() => evenTicks(rows, "date", dateTickCount(isMobile)), [rows, isMobile]);

  // Where y=0 sits as a fraction from the TOP of the SVG (SVG y-axis is inverted)
  const zeroStopPct = useMemo(() => {
    const [dMin, dMax] = domain;
    if (dMax === dMin) return "50%";
    const frac = Math.max(0, Math.min(1, (dMax - 0) / (dMax - dMin)));
    return `${(frac * 100).toFixed(2)}%`;
  }, [domain]);

  const bars = useMemo(() => (chartType === "bar" ? bucketBalances(series) : []), [chartType, series]);

  const renderBarTooltip = ({ active, payload }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload as BarRow;
    const figures: Record<TrendSeriesKey, number> = {
      net_worth: row.net_worth, total_assets: row.total_assets, total_liabilities: -row.owed,
    };
    return (
      <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-md">
        <p className="text-muted-foreground mb-1">{row.label}</p>
        {visible.map((s) => (
          <p key={s.key} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color ?? netWorthColor }} />
              {s.label}
            </span>
            <span className="font-medium">{formatCurrency(figures[s.key])}</span>
          </p>
        ))}
      </div>
    );
  };

  const span = spanInDays(rows[0]?.date?.slice(0, 10), rows[rows.length - 1]?.date?.slice(0, 10));
  const fmtPct = (v: number, digits = 2) => `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

  const renderTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    // Dollar values come from the raw point, so % mode can show both.
    const point = series.find((p) => p.date === label);
    if (!point) return null;
    const row = payload[0].payload as Partial<Record<TrendSeriesKey, number>>;
    return (
      <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-md">
        <p className="text-muted-foreground mb-1">
          {isIntraday ? `${formatShortDate(String(label).slice(0, 10))}, ${fmtTime(String(label))}` : formatDate(String(label))}
        </p>
        {visible.map((s) => (
          <p key={s.key} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color ?? netWorthColor }} />
              {s.label}
            </span>
            <span className="font-medium">
              {formatCurrency(point[s.key])}
              {viewMode === "pct" && typeof row[s.key] === "number" && (
                <span className="ml-1.5 font-normal text-muted-foreground">{fmtPct(row[s.key] as number)}</span>
              )}
            </span>
          </p>
        ))}
      </div>
    );
  };

  return (
    <div
      onClick={to ? onCardClick : undefined}
      className={cn("rounded-xl border border-border bg-card p-4", to && clickableCardClass, className)}
    >
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div>
          <CardTitle title={title} to={to} />
          {hasData && !hidden.has("net_worth") && chartType !== "sankey" && (
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-lg font-bold">{formatCurrency(lastVal)}</span>
              <span className={`text-sm font-medium ${isPositive ? "text-success" : "text-destructive"}`}>
                {isPositive ? "+" : ""}{formatCurrency(gain)}
                {gainPct !== null && ` (${isPositive ? "+" : ""}${gainPct.toFixed(2)}%)`}
              </span>
              {session?.date && !session.is_current && (
                <span className="text-xs text-muted-foreground">last session, {formatShortDate(session.date)}</span>
              )}
            </div>
          )}
        </div>
        {/* Wraps at phone width rather than pushing the date button past the
            card's edge. */}
        <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
          {!chart && <SegmentedToggle value={chosenChart} onChange={setChosenChart} options={CHART_TYPES} />}
          {/* $ / % toggle. The bars are dollar amounts stacked either side of
              zero, which a percentage change has no meaning for. */}
          <div className={cn("flex rounded-md border border-border overflow-hidden text-xs font-medium shrink-0", chartType !== "line" && "hidden")}>
            <button
              onClick={() => setViewMode("dollar")}
              aria-label="Show dollar values"
              aria-pressed={viewMode === "dollar"}
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
              aria-label="Show percent change"
              aria-pressed={viewMode === "pct"}
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
          {chartType !== "sankey" && zoom.resetButton}
          {chartType !== "sankey" && (
            <DateRangePicker
              value={dateRange}
              onChange={setDateRange}
              onClearAll={() => setDateRange(null)}
            />
          )}
        </div>
      </div>
      {chartType === "sankey" ? (
        <NetWorthSankey height={Math.max(height, 280)} />
      ) : isLoading ? (
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : !hasData ? (
        <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
          No trend data yet. Visit this page daily to build your history.
        </div>
      ) : chartType === "bar" ? (
        <>
          <ResponsiveContainer width="100%" height={height}>
            <ComposedChart data={bars} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10 }}
                interval={Math.max(0, Math.floor(bars.length / dateTickCount(isMobile)))}
              />
              <YAxis {...moneyAxisFor(bars, ["total_assets", "owed", "net_worth"])} tick={{ fontSize: 10 }} width={56} />
              <ReferenceLine y={0} stroke="hsl(var(--border))" />
              <Tooltip content={renderBarTooltip} cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} />
              {/* One stack, split by sign: owned up from zero, owed down. */}
              <Bar
                dataKey="total_assets" stackId="balance" fill={SERIES[1].color} radius={[3, 3, 0, 0]}
                maxBarSize={36} hide={hidden.has("total_assets")}
              />
              <Bar
                dataKey="owed" stackId="balance" fill={SERIES[2].color} radius={[3, 3, 0, 0]}
                maxBarSize={36} hide={hidden.has("total_liabilities")}
              />
              <Line
                type="monotone" dataKey="net_worth" stroke={netWorthColor} strokeWidth={2}
                dot={bars.length <= 31 ? { r: 2.5, fill: netWorthColor, strokeWidth: 0 } : false}
                hide={hidden.has("net_worth")}
              />
            </ComposedChart>
          </ResponsiveContainer>
          <TrendLegend first={first} last={last} hidden={hidden} onToggle={toggleSeries} netWorthColor={netWorthColor} />
        </>
      ) : (
        <div {...zoom.wrapperProps}>
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} {...zoom.chartProps}>
              <defs>
                <linearGradient id="nwGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={netWorthColor} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={netWorthColor} stopOpacity={0} />
                </linearGradient>
                {/* % mode: green above zero, red below — transition at y=0 */}
                <linearGradient id="nwPctFillGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"          stopColor={UP} stopOpacity={0.25} />
                  <stop offset={zeroStopPct} stopColor={UP} stopOpacity={0.05} />
                  <stop offset={zeroStopPct} stopColor={DOWN} stopOpacity={0.05} />
                  <stop offset="100%"        stopColor={DOWN} stopOpacity={0.25} />
                </linearGradient>
                <linearGradient id="nwPctStrokeGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"          stopColor={UP} />
                  <stop offset={zeroStopPct} stopColor={UP} />
                  <stop offset={zeroStopPct} stopColor={DOWN} />
                  <stop offset="100%"        stopColor={DOWN} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} ticks={ticks} interval={0}
                tickFormatter={(d) => (isIntraday ? fmtTime(d) : formatAxisDate(d, span))} />
              <YAxis
                tickFormatter={viewMode === "pct" ? (v) => fmtPct(v, pctDigits) : (v) => formatAxisMoney(v)}
                tick={{ fontSize: 10 }}
                width={56}
                domain={domain}
                ticks={yScale?.ticks}
              />
              <Tooltip content={renderTooltip} />
              {zoom.area}
              {/* Net worth first, so its filled band sits behind the two lines */}
              <Area
                type="monotone"
                dataKey="net_worth"
                stroke={viewMode === "pct" ? "url(#nwPctStrokeGrad)" : netWorthColor}
                strokeWidth={2}
                fill={viewMode === "pct" ? "url(#nwPctFillGrad)" : "url(#nwGrad)"}
                dot={false}
                hide={hidden.has("net_worth")}
              />
              {SERIES.filter((s) => s.color).map((s) => (
                <Area
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={1.5}
                  fill="none"
                  dot={false}
                  hide={hidden.has(s.key)}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
          <TrendLegend first={first} last={last} hidden={hidden} onToggle={toggleSeries} netWorthColor={netWorthColor} />
        </div>
      )}
    </div>
  );
}

/** The legend doubles as the switch for each line, and carries what the lines
 *  alone do not: where assets and liabilities ended up, and by how much each
 *  moved over the range. (Net worth's figures are the card's headline.) */
function TrendLegend({ first, last, hidden, onToggle, netWorthColor }: {
  first: NetWorthPoint;
  last: NetWorthPoint;
  hidden: Set<TrendSeriesKey>;
  onToggle: (key: TrendSeriesKey) => void;
  netWorthColor: string;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
      {SERIES.map((s) => {
        const off = hidden.has(s.key);
        const change = last[s.key] - first[s.key];
        const pct = first[s.key] > 0 ? (change / first[s.key]) * 100 : null;
        const flat = Math.abs(change) < 0.5;
        const good = s.upIsGood ? change > 0 : change < 0;
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!off}
            title={off ? `Show ${s.label.toLowerCase()}` : `Hide ${s.label.toLowerCase()}`}
            className={cn(
              "flex items-center gap-1.5 rounded px-1 py-0.5 text-xs tabular-nums transition-opacity",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
              off && "opacity-50",
            )}
          >
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color ?? netWorthColor }} />
            <span className={cn("text-foreground", off && "line-through")}>{s.label}</span>
            {s.key !== "net_worth" && (
              <>
                <span className="font-medium text-foreground">{formatCurrency(last[s.key])}</span>
                <span className={flat ? "text-muted-foreground" : good ? "text-success" : "text-destructive"}>
                  {flat
                    ? "no change"
                    : `${change > 0 ? "+" : "−"}${formatCurrency(Math.abs(change))}${pct === null ? "" : ` (${change > 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%)`}`}
                </span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

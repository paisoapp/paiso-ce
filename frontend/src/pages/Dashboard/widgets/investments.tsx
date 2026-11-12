import { useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { FeeAnalysisCard } from "@/components/portfolio/FeeAnalysisCard";
import { slotColor } from "@/lib/chartPalette";
import { useDashboardData } from "@/hooks/useDashboard";
import { useHoldings, useIncomeSummary } from "@/hooks/useHoldings";
import { formatCompact, formatCurrency, cn } from "@/lib/utils";
import { EmptyState, StatCard, WidgetCard, WidgetSkeleton, tooltipStyle, useChartDark } from "./common";

const MONTHS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

function signed(v: number, fmt: (n: number) => string) {
  return `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
}

export function InvestmentsStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  const pct = data.total_cost_basis > 0 ? (data.total_gain / data.total_cost_basis) * 100 : null;
  return (
    <StatCard
      label="Investments"
      value={formatCurrency(data.investment_value)}
      to="/investments/stocks"
      sub={
        data.costed_value > 0 ? (
          <span className={data.total_gain >= 0 ? "text-success" : "text-destructive"}>
            {signed(data.total_gain, formatCurrency)}
            {pct != null && ` (${signed(pct, (n) => n.toFixed(1))}%)`} on cost basis
          </span>
        ) : (
          `Assets: ${formatCurrency(data.total_assets)}`
        )
      }
    />
  );
}

export function FeeAnalysisWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return <FeeAnalysisCard fee={data.fee_analysis} className="h-full" to="/portfolio#fee-analysis" />;
}

// ── Top holdings / today's movers ───────────────────────────────────────────

interface Position {
  key: string;
  ticker: string | null;
  name: string;
  value: number;
  dayGain: number;
  dayPct: number;
}

export function TopHoldingsWidget() {
  const { data, isLoading } = useHoldings();
  const [view, setView] = useState<"largest" | "movers">("largest");

  const positions = useMemo(() => {
    // One line per security, however many accounts hold it.
    const by = new Map<string, Position>();
    for (const h of data ?? []) {
      // Positions only: an account balance or uninvested cash is not a
      // holding to rank.
      if (h.kind === "balance" || h.is_balance_account) continue;
      if (h.exclude_from_net_worth || h.current_value <= 0) continue;
      const key = h.ticker ?? h.row_key ?? `sec-${h.security_id}`;
      const p = by.get(key) ?? { key, ticker: h.ticker, name: h.name, value: 0, dayGain: 0, dayPct: 0 };
      p.value += h.current_value;
      p.dayGain += h.day_gain ?? 0;
      by.set(key, p);
    }
    const out = [...by.values()];
    for (const p of out) {
      const prior = p.value - p.dayGain;
      p.dayPct = prior > 0 ? (p.dayGain / prior) * 100 : 0;
    }
    return out;
  }, [data]);

  if (isLoading) return <WidgetSkeleton />;
  const total = positions.reduce((s, p) => s + p.value, 0);
  const rows = [...positions]
    .sort((a, b) => (view === "largest" ? b.value - a.value : Math.abs(b.dayPct) - Math.abs(a.dayPct)))
    .slice(0, 6);

  const toggle = (
    <div className="flex rounded-md border border-border overflow-hidden text-[11px] font-medium">
      {(["largest", "movers"] as const).map((v, i) => (
        <button
          key={v}
          type="button"
          onClick={() => setView(v)}
          aria-pressed={view === v}
          className={cn(
            "px-2 py-0.5 transition-colors",
            i > 0 && "border-l border-border",
            view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "largest" ? "Largest" : "Movers"}
        </button>
      ))}
    </div>
  );

  return (
    <WidgetCard title="Top Holdings" headerExtra={toggle} to="/investments/stocks">
      {rows.length === 0 ? (
        <EmptyState>No holdings yet.</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((p) => (
            <li key={p.key} className="flex items-center gap-3 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate">{p.ticker ?? p.name}</p>
                {p.ticker && <p className="text-[11px] text-muted-foreground truncate">{p.name}</p>}
              </div>
              <div className="text-right">
                <p className="tabular-nums">{formatCurrency(p.value)}</p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {total > 0 ? `${((p.value / total) * 100).toFixed(1)}%` : ""}
                </p>
              </div>
              <span
                className={cn(
                  "w-16 text-right tabular-nums text-xs font-medium",
                  p.dayPct > 0 ? "text-success" : p.dayPct < 0 ? "text-destructive" : "text-muted-foreground",
                )}
                title="Today's change"
              >
                {signed(p.dayPct, (n) => n.toFixed(2))}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  );
}

// ── Dividend income ─────────────────────────────────────────────────────────

export function DividendIncomeWidget() {
  const dark = useChartDark();
  const { data, isLoading } = useIncomeSummary(true);
  if (isLoading) return <WidgetSkeleton />;
  if (!data) {
    return (
      <WidgetCard title="Investment Income">
        <EmptyState>No dividend or interest income recorded.</EmptyState>
      </WidgetCard>
    );
  }
  const bars = data.by_month.map((v, i) => ({ m: MONTHS[i], v }));
  return (
    <WidgetCard title={`Investment Income · ${data.year}`} to="/investments/stocks">
      <div className="flex items-baseline justify-between">
        <span className="text-lg font-bold tabular-nums">{formatCurrency(data.ytd_total ?? data.year_total)}</span>
        <span className="text-xs text-muted-foreground">~{formatCurrency(data.projected_annual)}/yr projected</span>
      </div>
      <ResponsiveContainer width="100%" height={90}>
        <BarChart data={bars} margin={{ left: 0, right: 0, top: 8, bottom: 0 }}>
          <XAxis dataKey="m" tick={{ fontSize: 9 }} stroke="hsl(var(--muted-foreground))" interval={0} />
          <Tooltip cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }} formatter={(v: number) => [`$${formatCompact(v)}`, "Income"]} contentStyle={tooltipStyle} />
          <Bar dataKey="v" fill={slotColor(0, dark)} radius={[4, 4, 0, 0]} maxBarSize={14} />
        </BarChart>
      </ResponsiveContainer>
    </WidgetCard>
  );
}

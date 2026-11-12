import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Columns3, Eye, EyeOff, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { AccountLogo, typeStyle } from "@/components/accounts/AccountList";
import { useUpdateAccount } from "@/hooks/useAccounts";
import { InfoPopover } from "@/components/ui/InfoPopover";
import { useHoldings, type Holding } from "@/hooks/useHoldings";
import { AccountBalanceChart } from "@/components/accounts/AccountBalanceCharts";
import { useAccountValueHistory, useInvestmentsOverview, type OverviewCard } from "@/hooks/useInvestmentsOverview";
import { cn, formatCurrency, formatCurrencyFull, matchesSearch } from "@/lib/utils";
import { useUiPrefsStore } from "@/store/uiPrefs";
import {
  ACCOUNT_EXCLUDE_HELP, EditHoldingDrawer, MiniRangeScale, OVERLAY_COLORS,
  OverlayToggleButton, PortfolioTrendChart, RowVisibilityFields, sessionSuffix,
} from "./StocksPage";

/**
 * Retirement, Education and Health: the Stocks & Funds page, one row per plan.
 *
 * The same performance chart (date range, $/% toggle, overlays), summary line,
 * search, account filter, column picker with drag-to-reorder, and the same
 * columns, plus the tab's own (Updated).
 *
 * A plan's value is the account's value from the investment book. A synced
 * plan is its positions at live prices (a fund with no public ticker at the
 * institution's price), and expands to every one of them, cash included. A
 * plan kept by hand is its tickers at market price plus the "Other funds" the
 * user entered, which is never broken down. A plan synced with no positions is
 * its balance and does not expand. A plan can be overlaid on the chart as its
 * own line, as can any ticker in it.
 */

type PlanTabType = "retirement" | "education" | "health";

const PLAN_COL_KEYS = [
  "account", "shares", "price", "day_change", "day_range", "week52_range",
  "current_value", "day_gain", "cost_basis", "basis_per_share", "total_gain", "return_pct",
] as const;
type ColKey = typeof PLAN_COL_KEYS[number];
const COL_LABELS: Record<ColKey, string> = {
  account: "Account",
  shares: "Shares",
  price: "Price",
  day_change: "Intraday Chg",
  day_range: "Today's Range",
  week52_range: "52-Week Range",
  current_value: "Value",
  day_gain: "Day G/L",
  cost_basis: "Cost Basis",
  basis_per_share: "Basis/Share",
  total_gain: "Total G/L",
  return_pct: "Return %",
};
const LEFT_COLS = new Set<ColKey>(["account"]);
type SortKey = "name" | "current_value" | "day_gain" | "cost_basis" | "total_gain" | "return_pct";
const SORTABLE: Partial<Record<ColKey, SortKey>> = {
  current_value: "current_value", day_gain: "day_gain", cost_basis: "cost_basis",
  total_gain: "total_gain", return_pct: "return_pct",
};

interface PlanRow {
  card: OverviewCard;
  /** The positions that value the plan, excluded from net worth or not. */
  tickers: Holding[];
  /** What its expanded row lists. */
  listed: Holding[];
  otherFunds: number;
  dayGain: number | null;
  costBasis: number | null;
  gain: number | null;
  returnPct: number | null;
}

function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? null : Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/** How current the plan's number is, in a few words. */
function updatedLabel(c: OverviewCard, hasTickers: boolean): { text: string; stale: boolean } {
  if (c.updated_by_hand_on) {
    const days = daysSince(c.updated_by_hand_on) ?? 0;
    return {
      text: days <= 0 ? "Updated today" : days === 1 ? "Updated yesterday" : `Updated ${days} days ago`,
      stale: !!c.stale,
    };
  }
  if (c.stale) return { text: "Never updated", stale: true };
  return { text: hasTickers ? "Market prices" : "—", stale: false };
}

const tone = (v: number | null | undefined) =>
  v == null ? "" : v >= 0 ? "text-success" : "text-destructive";
const signed = (v: number) => `${v >= 0 ? "+" : ""}${formatCurrency(v)}`;
const dash = <span className="tabular-nums text-muted-foreground">—</span>;

/** Column order and visibility, saved per tab (as Stocks & Funds saves its own). */
function useColumns(tab: PlanTabType) {
  const keys: ColKey[] = [...PLAN_COL_KEYS];
  const orderKey = `inv-plans-col-order-${tab}`;
  const hiddenKey = `inv-plans-cols-${tab}`;
  const [order, setOrder] = useState<ColKey[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(orderKey) || "[]") as ColKey[];
      const out = saved.filter((k) => keys.includes(k));
      // A column added since the order was saved goes where it sits by
      // default, after the column it follows, not at the far end.
      keys.forEach((k, i) => {
        if (out.includes(k)) return;
        const after = keys.slice(0, i).reverse().find((p) => out.includes(p));
        out.splice(after ? out.indexOf(after) + 1 : 0, 0, k);
      });
      return out;
    } catch { return keys; }
  });
  const [hidden, setHidden] = useState<ColKey[]>(() => {
    try { return JSON.parse(localStorage.getItem(hiddenKey) || "[]"); } catch { return []; }
  });
  useEffect(() => {
    try {
      localStorage.setItem(orderKey, JSON.stringify(order));
      localStorage.setItem(hiddenKey, JSON.stringify(hidden));
    } catch { /* storage off */ }
  }, [orderKey, hiddenKey, order, hidden]);
  return {
    all: order,
    visible: order.filter((c) => !hidden.includes(c)),
    toggle: (c: ColKey) => setHidden((h) => (h.includes(c) ? h.filter((x) => x !== c) : [...h, c])),
    isHidden: (c: ColKey) => hidden.includes(c),
    move: (from: ColKey, to: ColKey) => setOrder((o) => {
      const next = o.filter((k) => k !== from);
      next.splice(next.indexOf(to) + (o.indexOf(from) < o.indexOf(to) ? 1 : 0), 0, from);
      return next;
    }),
    reset: () => { setOrder(keys); setHidden([]); },
  };
}

export function PlansTab({ type, emptyHint }: { type: PlanTabType; emptyHint: string }) {
  const { data: overview, isLoading } = useInvestmentsOverview();
  const { data: holdings = [] } = useHoldings();
  // A year of each plan's value, for its 52-week range when collapsed.
  const yearRange = useMemo(() => {
    const to = new Date();
    const from = new Date(to.getTime() - 365 * 86_400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, []);
  const { data: yearHistory } = useAccountValueHistory(yearRange);
  const cols = useColumns(type);
  const [search, setSearch] = useState("");
  const [accountFilter, setAccountFilter] = useState<number | "">("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("current_value");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [dragKey, setDragKey] = useState<ColKey | null>(null);
  const [dropKey, setDropKey] = useState<ColKey | null>(null);
  const [overlays, setOverlays] = useState<string[]>([]);
  const [isIntraday, setIsIntraday] = useState(false);
  const [openId, setOpenId] = useState<number | null>(() => {
    const id = Number(new URLSearchParams(window.location.search).get("account"));
    return Number.isFinite(id) && id > 0 ? id : null;
  });
  const [colMenu, setColMenu] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  // Rows hidden from these tables (ui_prefs), plans keyed "plan:<id>"; the
  // drawers of the positions in an expanded plan.
  const hiddenRows = useUiPrefsStore((st) => st.hiddenHoldingRows);
  const hiddenSet = useMemo(() => new Set(hiddenRows), [hiddenRows]);
  const [showHidden, setShowHidden] = useState(false);
  const [drawerHoldingId, setDrawerHoldingId] = useState<number | null>(null);
  const isHidden = (key: string | null | undefined) => !!key && hiddenSet.has(key);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (colMenuRef.current && !colMenuRef.current.contains(e.target as Node)) setColMenu(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const rows: PlanRow[] = useMemo(() => {
    const group = overview?.groups.find((g) => g.purpose === type);
    return (group?.accounts ?? [])
      .filter((c) => c.kind === "account" && c.id != null)
      .map((card) => {
        const own = holdings.filter((h) => h.account_id === card.id);
        // The tickers we price; the rest is the Other funds value the user
        // entered.
        const listed = own.filter((h) => h.kind === "holding" && !!h.ticker
          && (h.price_source === "live" || h.price_source === "close"));
        // Excluding a plan or a position counts against net worth only. On
        // this tab every position values its plan.
        const tickers = listed;
        const tickerValue = tickers.reduce((s, h) => s + h.current_value, 0);
        const costs = tickers.filter((h) => h.cost_basis_total != null);
        const contrib = card.contributions_total ?? null;
        const otherFunds = Math.max(0, card.value - tickerValue);
        const costBasis = costs.length || contrib != null
          ? costs.reduce((s, h) => s + (h.cost_basis_total ?? 0), 0) + (contrib ?? 0)
          : null;
        // Gain only over the parts whose cost is known: tickers with a basis,
        // and Other funds when "total contributed" was entered. A fund with no
        // basis must not count its whole value as gain.
        const gain = costBasis == null ? null
          : costs.reduce((s, h) => s + (h.total_gain ?? 0), 0) + (contrib != null ? otherFunds - contrib : 0);
        return {
          card,
          tickers,
          listed,
          otherFunds,
          dayGain: tickers.length ? tickers.reduce((s, h) => s + (h.day_gain ?? 0), 0) : null,
          costBasis,
          gain,
          returnPct: gain != null && costBasis ? (gain / costBasis) * 100 : null,
        };
      });
  }, [overview, holdings, type]);

  const accounts = rows.map((r) => ({ id: r.card.id!, name: r.card.name }));
  const sortVal = (r: PlanRow): number | string => {
    switch (sortKey) {
      case "name": return r.card.name.toLowerCase();
      case "current_value": return r.card.value;
      case "day_gain": return r.dayGain ?? -Infinity;
      case "cost_basis": return r.costBasis ?? -Infinity;
      case "total_gain": return r.gain ?? -Infinity;
      case "return_pct": return r.returnPct ?? -Infinity;
    }
  };
  const filtered = rows
    .filter((r) => showHidden || !isHidden(`plan:${r.card.id}`))
    .filter((r) => accountFilter === "" || r.card.id === accountFilter)
    .filter((r) => !search.trim() || matchesSearch(
      [r.card.name, r.card.subtype_label, r.card.institution,
       ...r.tickers.map((t) => `${t.ticker} ${t.name}`)].filter(Boolean).join(" "), search))
    .sort((a, b) => {
      const av = sortVal(a), bv = sortVal(b);
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(k); setSortDir(k === "name" ? "asc" : "desc"); }
  };

  // A plan excluded from net worth is dimmed, and counted like any other: the
  // totals and the chart are the plans' market value. The part net
  // worth leaves out is named beside the total.
  const counted = filtered;
  const total = counted.reduce((s, r) => s + r.card.value, 0);
  const excludedTotal = counted.reduce((s, r) => s + (r.card.excluded_value ?? 0), 0);
  const dayTotal = counted.reduce((s, r) => s + (r.dayGain ?? 0), 0);
  const gainRows = counted.filter((r) => r.gain != null);
  const hiddenCount = rows.filter((r) => isHidden(`plan:${r.card.id}`)).length
    + rows.reduce((n, r) => n + r.listed.filter((t) => isHidden(t.row_key)).length, 0);
  const gainTotal = gainRows.reduce((s, r) => s + (r.gain ?? 0), 0);
  const stale = filtered.filter((r) => r.card.stale).length;
  const open = rows.find((r) => r.card.id === openId) ?? null;

  // The chart covers the plans in view. Plans can be overlaid for
  // comparison; the positions inside them cannot.
  const chartAccountIds = filtered.map((r) => r.card.id!);
  const overlayLabels = Object.fromEntries(rows.map((r) => [`acct:${r.card.id}`, r.card.name]));
  const availableTickers = rows.map((r) => ({ ticker: `acct:${r.card.id}`, name: r.card.name }));
  const toggleOverlay = (key: string) =>
    setOverlays((o) => (o.includes(key) ? o.filter((k) => k !== key) : [...o, key]));
  const overlayButton = (key: string, label: string) => {
    const isActive = overlays.includes(key);
    return (
      <OverlayToggleButton
        ticker={label}
        isActive={isActive}
        overlayColor={isActive ? OVERLAY_COLORS[overlays.indexOf(key) % OVERLAY_COLORS.length] : undefined}
        isChartIntraday={isIntraday}
        onToggle={(e) => { e.stopPropagation(); toggleOverlay(key); }}
      />
    );
  };

  const toggleExpand = (id: number) =>
    setExpanded((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (isLoading) return <div className="h-40 rounded-xl bg-muted animate-pulse" />;

  function planCell(r: PlanRow, c: ColKey) {
    switch (c) {
      case "account": return <span className="text-muted-foreground">{r.card.name}</span>;
      // A plan has no share count or price of its own: say what it holds, how
      // it moved today as a whole, and where its value sat over the year.
      case "shares": {
        const n = r.tickers.length + (r.otherFunds >= 0.005 ? 1 : 0);
        return r.tickers.length
          ? <span className="text-muted-foreground whitespace-nowrap">{n} holding{n === 1 ? "" : "s"}</span> : dash;
      }
      case "day_change": {
        const before = r.card.value - (r.dayGain ?? 0);
        if (r.dayGain == null || before <= 0) return dash;
        const pct = (r.dayGain / before) * 100;
        return <span className={cn("tabular-nums", tone(pct))}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>;
      }
      case "week52_range": {
        const pts = yearHistory?.series[String(r.card.id)] ?? [];
        if (pts.length < 2) return dash;
        const vals = [...pts.map((p) => p.balance), r.card.value];
        return <MiniRangeScale low={Math.min(...vals)} high={Math.max(...vals)} value={r.card.value} />;
      }
      case "price": case "day_range": case "basis_per_share":
        return dash;
      case "current_value": return <span className="tabular-nums font-medium">{formatCurrency(r.card.value)}</span>;
      case "day_gain": return r.dayGain == null ? dash
        : <span className={cn("tabular-nums", tone(r.dayGain))}>{signed(r.dayGain)}</span>;
      case "cost_basis": return r.costBasis == null ? dash
        : <span className="tabular-nums text-muted-foreground">{formatCurrency(r.costBasis)}</span>;
      case "total_gain": return r.gain == null ? dash
        : <span className={cn("tabular-nums", tone(r.gain))}>{formatCurrency(r.gain)}</span>;
      case "return_pct": return r.returnPct == null ? dash
        : <span className={cn("tabular-nums", tone(r.returnPct))}>{r.returnPct.toFixed(2)}%</span>;
    }
  }

  function tickerCell(t: Holding, c: ColKey) {
    switch (c) {
      case "account": return <span className="text-muted-foreground">{t.account_name}</span>;
      case "shares": return t.shares == null ? dash
        : <span className="tabular-nums">{t.shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</span>;
      case "price": return t.price == null ? dash : <span className="tabular-nums">{formatCurrencyFull(t.price)}</span>;
      case "day_change": return !t.ticker ? dash : (
        <span className={cn("tabular-nums", tone(t.day_change))} title={`Change for ${sessionSuffix(t.day_change_session)}`}>
          {t.day_change >= 0 ? "+" : ""}{formatCurrencyFull(t.day_change)}
          <span className="text-xs ml-1">({t.day_change >= 0 ? "+" : ""}{t.day_change_pct.toFixed(2)}%)</span>
        </span>
      );
      case "day_range": return !t.ticker ? dash : <MiniRangeScale low={t.day_low} high={t.day_high} value={t.price} />;
      case "week52_range": return !t.ticker ? dash : <MiniRangeScale low={t.week52_low} high={t.week52_high} value={t.price} />;
      case "current_value": return <span className="tabular-nums">
        {formatCurrency(t.current_value)}</span>;
      case "day_gain": return !t.ticker ? dash : <span className={cn("tabular-nums", tone(t.day_gain))}>{formatCurrency(t.day_gain ?? 0)}</span>;
      case "cost_basis": return t.cost_basis_total != null && t.cost_basis_total > 0
        ? <span className="tabular-nums text-muted-foreground">{formatCurrency(t.cost_basis_total)}</span> : dash;
      case "basis_per_share": return t.cost_basis_total && t.shares != null && t.shares > 0
        ? <span className="tabular-nums text-muted-foreground">{formatCurrencyFull(t.cost_basis_total / t.shares)}</span> : dash;
      case "total_gain": return t.total_gain == null ? dash
        : <span className={cn("tabular-nums", tone(t.total_gain))}>{formatCurrency(t.total_gain)}</span>;
      case "return_pct": return t.total_gain_pct == null ? dash
        : <span className={cn("tabular-nums", tone(t.total_gain_pct))}>{t.total_gain_pct.toFixed(2)}%</span>;
    }
  }

  const align = (c: ColKey) => (LEFT_COLS.has(c) ? "text-left" : "text-right");

  return (
    <div className="space-y-4">
      <PortfolioTrendChart
        plansMode
        rangeSection={`investments_${type}`}
        accountIds={chartAccountIds}
        title="Performance"
        seriesLabel={`All ${type} plans`}
        overlayLabels={overlayLabels}
        availableTickers={availableTickers}
        overlayTickers={overlays}
        onToggleOverlay={toggleOverlay}
        onClearOverlays={() => setOverlays([])}
        onIntradayChange={setIsIntraday}
      />

      {/* Summary + actions bar, as on Stocks & Funds */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="text-muted-foreground">Market Value: <span className="font-semibold text-foreground tabular-nums">{formatCurrency(total)}</span>
          {excludedTotal >= 0.005 && <> ({formatCurrency(excludedTotal)} excluded from net worth)</>}
        </span>
        {filtered.some((r) => r.dayGain != null) && (
          <span className={tone(dayTotal)}>Day G/L: {signed(dayTotal)}</span>
        )}
        {gainRows.length > 0 && <span className={tone(gainTotal)}>Total G/L: {signed(gainTotal)}</span>}
      </div>

      {stale > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <AlertTriangle size={14} className="text-amber-600" />
          {stale === 1
            ? `A value you entered is over ${overview?.manual_price_stale_days ?? 30} days old. Open the plan to update it.`
            : `${stale} values you entered are over ${overview?.manual_price_stale_days ?? 30} days old. Open a plan to update it.`}
        </div>
      )}

      {/* Search + filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search plans, tickers…"
            className="w-full h-9 rounded-md border border-border bg-background pl-8 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        {accounts.length > 1 && (
          <AccountFilterSelect value={accountFilter} onChange={(id) => setAccountFilter(id ?? "")} accounts={accounts} />
        )}
        {hiddenCount > 0 && (
          <Button size="sm" variant="outline" onClick={() => setShowHidden((v) => !v)}
            title={showHidden ? "Take hidden rows out of the table again" : "Show the rows you hid"}>
            {showHidden ? <><EyeOff size={13} /> Hide hidden</> : <><Eye size={13} /> Show hidden ({hiddenCount})</>}
          </Button>
        )}
        {showHidden && hiddenCount > 0 && (
          <p className="basis-full order-last text-xs text-muted-foreground">Hidden rows are dimmed. Open one and untick “Hide from table” to put it back.</p>
        )}
        <div className="relative hidden md:block" ref={colMenuRef}>
          <Button size="sm" variant="outline" onClick={() => setColMenu((v) => !v)}>
            <Columns3 size={13} /> Columns
          </Button>
          {colMenu && (
            <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-card p-1 shadow-lg">
              {cols.all.map((c) => (
                <label key={c} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted/50 cursor-pointer">
                  <input type="checkbox" checked={!cols.isHidden(c)} onChange={() => cols.toggle(c)} />
                  {COL_LABELS[c]}
                </label>
              ))}
              <button type="button" onClick={cols.reset}
                className="mt-1 w-full rounded px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50">
                Reset columns
              </button>
            </div>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
          {rows.length === 0 ? emptyHint : "No plans match your search."}
        </div>
      ) : (
        <>
          {/* Table (md+) */}
          <div className="hidden md:block rounded-xl border border-border overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted border-b border-border">
                  <tr>
                    <th className="w-8" />
                    <th onClick={() => toggleSort("name")}
                      className="px-3 py-2.5 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground whitespace-nowrap">
                      Plan{sortKey === "name" ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                    </th>
                    {cols.visible.map((c) => {
                      const sk = SORTABLE[c];
                      const isTarget = dropKey === c && dragKey !== c;
                      return (
                        <th
                          key={c}
                          draggable
                          onDragStart={() => setDragKey(c)}
                          onDragOver={(e) => { e.preventDefault(); setDropKey(c); }}
                          onDragEnd={() => { setDragKey(null); setDropKey(null); }}
                          onDrop={() => { if (dragKey && dragKey !== c) cols.move(dragKey, c); setDragKey(null); setDropKey(null); }}
                          onClick={() => sk && toggleSort(sk)}
                          title="Drag to reorder"
                          className={cn(
                            "px-3 py-2.5 font-medium text-muted-foreground select-none whitespace-nowrap transition-colors",
                            align(c),
                            sk ? "cursor-pointer hover:text-foreground" : "cursor-grab hover:text-foreground",
                            dragKey === c && "opacity-40",
                            isTarget && "bg-primary/10",
                          )}
                        >
                          {COL_LABELS[c]}
                          {sk && sortKey === sk ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border bg-card">
                  {filtered.map((r) => {
                    const id = r.card.id!;
                    const shownPositions = r.listed.filter((t) => showHidden || !isHidden(t.row_key));
                    const canExpand = shownPositions.length > 0;
                    const isOpen = expanded.has(id);
                    return (
                      <Fragment key={id}>
                        <tr onClick={() => setOpenId(id)}
                          className={cn("cursor-pointer hover:bg-muted/40 transition-colors",
                            (r.card.excluded || isHidden(`plan:${id}`)) && "opacity-60")}>
                          <td className="pl-2">
                            {canExpand && (
                              <button
                                type="button"
                                aria-label={isOpen ? "Collapse" : "Expand"}
                                onClick={(e) => { e.stopPropagation(); toggleExpand(id); }}
                                className="p-1 rounded text-muted-foreground hover:text-foreground"
                              >
                                {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              </button>
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-2">
                              {overlayButton(`acct:${id}`, r.card.name)}
                              <AccountLogo size="sm" accent={typeStyle(r.card.account_type)} />
                              <div className="min-w-0">
                                <p className="font-medium truncate">{r.card.subtype_label ?? r.card.name}</p>
                                <p className="text-xs text-muted-foreground/80 truncate">
                                  {r.card.institution || r.card.name}
                                </p>
                                {(() => {
                                  const u = updatedLabel(r.card, r.tickers.length > 0);
                                  return u.stale ? (
                                    <p className="text-[11px] text-amber-600 whitespace-nowrap">
                                      <AlertTriangle size={10} className="inline mr-1 -mt-0.5" />{u.text}
                                    </p>
                                  ) : null;
                                })()}
                              </div>
                            </div>
                          </td>
                          {cols.visible.map((c) => (
                            <td key={c} className={cn("px-3 py-3", align(c))}>{planCell(r, c)}</td>
                          ))}
                        </tr>
                        {isOpen && (
                          <>
                            {shownPositions.map((t) => (
                              <tr key={t.row_key ?? t.id}
                                onClick={() => setDrawerHoldingId(t.id)}
                                className={cn("bg-muted/20 text-xs cursor-pointer hover:bg-muted/40 transition-colors",
                                  (t.exclude_from_net_worth || isHidden(t.row_key)) && "opacity-60")}>
                                <td />
                                <td className="px-3 py-2 pl-6">
                                  {t.ticker ? (
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-mono font-medium text-primary">{t.ticker}</span>
                                      <span className="text-muted-foreground truncate max-w-[12rem]">{t.name}</span>
                                    </div>
                                  ) : (
                                    <span className="pl-6 truncate max-w-[16rem] inline-block align-bottom">{t.name}</span>
                                  )}
                                </td>
                                {cols.visible.map((c) => (
                                  <td key={c} className={cn("px-3 py-2", align(c))}>{tickerCell(t, c)}</td>
                                ))}
                              </tr>
                            ))}
                            {r.otherFunds >= 0.005 && (
                              <tr className="bg-muted/20 text-xs">
                                <td />
                                <td className="px-3 py-2 pl-12 text-muted-foreground">Other funds</td>
                                {cols.visible.map((c) => (
                                  <td key={c} className={cn("px-3 py-2", align(c))}>
                                    {c === "current_value" && <span className="tabular-nums">{formatCurrency(r.otherFunds)}</span>}
                                  </td>
                                ))}
                              </tr>
                            )}
                          </>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Cards (mobile) */}
          <div className="md:hidden space-y-2">
            {filtered.map((r) => {
              const u = updatedLabel(r.card, r.tickers.length > 0);
              return (
                <button key={r.card.id} type="button" onClick={() => setOpenId(r.card.id!)}
                  className="w-full text-left rounded-xl border border-border bg-card px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{r.card.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[r.card.subtype_label, r.card.institution]
                          .filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <span className="tabular-nums font-medium">{formatCurrency(r.card.value)}</span>
                  </div>
                  <div className="mt-1 flex justify-between text-xs">
                    <span className={u.stale ? "text-amber-600" : "text-muted-foreground"}>{u.text}</span>
                    {r.gain != null && <span className={tone(r.gain)}>{signed(r.gain)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}

      {open && <PlanDrawer row={open} type={type} onClose={() => setOpenId(null)} />}
      <EditHoldingDrawer holding={holdings.find((h) => h.id === drawerHoldingId) ?? null}
        onClose={() => setDrawerHoldingId(null)} />
    </div>
  );
}

/** The plan's side drawer, laid out like Stocks & Funds' holding drawer: the
 *  plan's performance at the top, a panel of label/value rows (editable ones
 *  on a dashed underline), then Save. How current the value is
 *  shows in the table and the stale banner, not here. The account itself (name, type, sub-type, deleting it) is
 *  edited in Settings → Accounts, as everywhere else. */
function PlanDrawer({ row, type, onClose }: { row: PlanRow; type: PlanTabType; onClose: () => void }) {
  const c = row.card;
  const update = useUpdateAccount();
  // A plan counted at a balance entered earlier starts from that number.
  const initOther = c.other_funds_value?.toString()
    ?? (c.value_source === "balance" && row.tickers.length === 0 && c.value ? c.value.toString() : "");
  const [otherFunds, setOtherFunds] = useState(initOther);
  const [contrib, setContrib] = useState(c.contributions_total?.toString() ?? "");
  const [coverage, setCoverage] = useState<string>(c.hsa_coverage ?? "self");
  const savedHidden = useUiPrefsStore((st) => st.hiddenHoldingRows.includes(`plan:${c.id}`));
  const setRowHidden = useUiPrefsStore((st) => st.setHoldingRowHidden);
  const [hidden, setHidden] = useState(savedHidden);
  const [excluded, setExcluded] = useState(!!c.excluded);

  const initContrib = c.contributions_total?.toString() ?? "";
  const initCoverage = c.hsa_coverage ?? "self";
  const otherChanged = otherFunds !== (c.other_funds_value?.toString() ?? "");
  const dirty = otherChanged || contrib !== initContrib
    || (type === "health" && coverage !== initCoverage)
    || hidden !== savedHidden || excluded !== !!c.excluded;
  const num = (s: string) => (s.trim() === "" ? null : Number(s));

  async function save() {
    setRowHidden(`plan:${c.id}`, hidden);
    await update.mutateAsync({
      id: c.id!,
      ...(excluded !== !!c.excluded ? { exclude_from_net_worth: excluded } : {}),
      ...(otherChanged ? { other_funds_value: num(otherFunds) } : {}),
      ...(contrib !== initContrib ? { contributions_total: num(contrib) } : {}),
      ...(type === "health" && coverage !== initCoverage ? { hsa_coverage: coverage as "self" | "family" } : {}),
    });
    onClose();
  }

  const inputCls = "w-28 text-right bg-transparent border-b border-dashed border-border focus:outline-none focus:border-primary font-medium text-sm py-0 tabular-nums";

  return (
    <SideDrawer open onClose={onClose} title={c.name}>
      <div className="px-5 py-5 space-y-4">
        {/* The plan's own performance; its holdings are not charted here. */}
        <AccountBalanceChart accountId={c.id!} owed={false} currency="USD" title="Performance" />

        <div className="rounded-lg bg-muted/40 px-3 py-2.5 space-y-1 text-sm">
          <Row label="Account" value={c.name} />
          <Row label="Kind" value={[c.subtype_label, c.tax_treatment_label].filter(Boolean).join(" · ") || "—"} />
          <Row label="Market Value" value={formatCurrency(c.value)} />
          {row.dayGain != null && (
            <Row label="Today" value={signed(row.dayGain)} tone={tone(row.dayGain)} />
          )}
          <div className="flex justify-between items-center">
            <span className="text-muted-foreground">Other funds</span>
            <input type="number" step="0.01" min="0" value={otherFunds} placeholder="0.00"
              onChange={(e) => setOtherFunds(e.target.value)} className={inputCls} />
          </div>
          <div className="flex justify-between items-center">
            <span className="flex items-center gap-1 text-muted-foreground">
              Cost basis (other funds)
              <InfoPopover label="What is this?" iconOnly align="left">
                <p>
                  What you paid into the part of this plan that is not in a priced fund
                  ("Other funds"). Paiso uses it to work out the gain or loss on that money.
                </p>
                <p>Leave it empty if you do not know it. The gain is then left out for that part.</p>
              </InfoPopover>
            </span>
            <input type="number" step="0.01" min="0" value={contrib} placeholder="optional"
              onChange={(e) => setContrib(e.target.value)} className={inputCls} />
          </div>
          <Row label="Cost Basis" value={row.costBasis == null ? "—" : formatCurrency(row.costBasis)} />
          <Row label="Total G/L"
            value={row.gain == null ? "—" : `${formatCurrency(row.gain)}${row.returnPct != null ? ` (${row.returnPct.toFixed(2)}%)` : ""}`}
            tone={tone(row.gain)} />
          {type === "health" && (
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">Coverage</span>
              <select value={coverage} onChange={(e) => setCoverage(e.target.value)}
                className="bg-transparent border-b border-dashed border-border text-sm font-medium text-right focus:outline-none">
                <option value="self">Self-only</option>
                <option value="family">Family</option>
              </select>
            </div>
          )}
        </div>

        <RowVisibilityFields hidden={hidden} onHidden={setHidden}
          excluded={excluded} onExcluded={setExcluded} excludeHelp={ACCOUNT_EXCLUDE_HELP} />

        <Button className="w-full" disabled={!dirty} loading={update.isPending} onClick={save}>
          Save
        </Button>
      </div>
    </SideDrawer>
  );
}

function Row({ label, value, warn, tone: toneCls }: { label: string; value: string; warn?: boolean; tone?: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium text-right", warn && "text-amber-600", toneCls)}>{value}</span>
    </div>
  );
}

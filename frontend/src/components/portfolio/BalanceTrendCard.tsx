import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from "recharts";
import { useNetWorthTrend } from "@/hooks/usePortfolio";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import { useDragZoom } from "@/hooks/useDragZoom";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { dateTickCount, evenTicks, niceMoneyAxis } from "@/lib/chartTicks";
import { formatAxisDate, formatDate, spanInDays } from "@/lib/dates";
import { slotColor } from "@/lib/chartPalette";
import { cn, formatCurrency } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";
import { api } from "@/lib/api";
import type { AccountTypeGroup } from "@/types";
import { useAccounts } from "@/hooks/useAccounts";
import { AccountLogo } from "@/components/accounts/AccountList";
import { Popover } from "@/pages/Budgeting/budget/Popover";

type Kind = "cash" | "credit_cards" | "investments" | "loans" | "mortgages";
/** A line's key: a kind of account, "account" for the one account filtered
 *  to, or `a<id>` for one of several accounts drawn side by side. */
type LineKey = Kind | "account" | `a${number}`;
type Row = { date: string } & Partial<Record<LineKey, number>>;

// In the order, and so the colours, the Transactions donut gives the same
// account types: a type is one colour on both charts.
const KINDS: { key: Kind; group: AccountTypeGroup; label: string }[] = [
  { key: "cash", group: "cash", label: "Cash" },
  { key: "credit_cards", group: "credit_cards", label: "Credit cards" },
  { key: "investments", group: "investments", label: "Investments" },
  { key: "loans", group: "loan", label: "Loans" },
  { key: "mortgages", group: "mortgage", label: "Mortgages" },
];

/** Balances over time, one line per kind of account: cash, investments, and
 *  what is owed on cards, loans and mortgages.
 *
 *  On Transactions it follows the table's dates and, on a type's own tab,
 *  draws that type alone; with the table filtered to one account, it draws
 *  that account's own balance. As a dashboard widget it keeps its own range. */
export function BalanceTrendCard({
  dateFrom,
  dateTo,
  only,
  account,
  accounts,
  ownRange = false,
  title,
  height = 240,
  className,
}: {
  dateFrom?: string;
  dateTo?: string;
  /** Draw just this account type. */
  only?: AccountTypeGroup;
  /** Draw this one account's balance instead of the type totals. */
  account?: { id: number; name: string } | null;
  /** Draw one line per account, in these colours, instead of the type
   *  totals: a type's own tab, so each bank's card or account reads on its
   *  own. Ignored while `account` narrows the chart to one. */
  accounts?: { id: number; name: string; color: string }[];
  /** Carry a range picker of its own, for where no table supplies the dates. */
  ownRange?: boolean;
  title?: string;
  height?: number;
  className?: string;
}) {
  const dark = useIsDarkMode();
  const isMobile = useIsMobile();
  const { dateRange, setDateRange } = useSectionDateRange("dashboard");
  // With its own range, drag across the chart to zoom into those dates.
  // Otherwise the dates belong to the page around it.
  const zoom = useDragZoom({ range: dateRange, setRange: setDateRange, enabled: ownRange });
  const from = ownRange ? dateRange?.from : dateFrom;
  const to = ownRange ? dateRange?.to : dateTo;
  const { data: trend, isLoading: trendLoading } = useNetWorthTrend(from, to);
  // One account's own balance, from the endpoint its drawer charts. "All time"
  // (no dates) asks for the longest span the server charts.
  const accountQuery = from && to ? `date_from=${from}&date_to=${to}` : "days=3650";
  const perAccount = !account && !!accounts?.length;
  const byAccount = !!account || perAccount;
  const { data: accountHistory, isLoading: accountLoading } = useQuery<{
    series: Record<string, { date: string; balance: number }[]>;
  }>({
    // Several accounts come from one call for all of them, as on Accounts.
    queryKey: ["accounts", "balance-history", account?.id ?? "all", from ?? "all", to ?? "all"],
    queryFn: () => api.get(
      `/accounts/balance-history?${account ? `account_id=${account.id}&` : ""}${accountQuery}`,
    ),
    enabled: byAccount,
    staleTime: 5 * 60_000,
  });
  const isLoading = byAccount ? accountLoading : trendLoading;
  // Lines switched on or off from the legend; any other line shows by its rank.
  const [picked, setPicked] = useState<ReadonlyMap<LineKey, boolean>>(new Map());
  // The legend entry under the pointer: its line thickens, the rest fade.
  const [hovered, setHovered] = useState<LineKey | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const { data: allAccounts } = useAccounts();

  const series: Row[] = useMemo(() => {
    if (account) {
      return (accountHistory?.series[String(account.id)] ?? []).map((p) => ({ date: p.date, account: p.balance }));
    }
    if (perAccount) {
      // One row per date, each account's balance under its own key. An
      // account with no balance on a date is left out of that row.
      const rows = new Map<string, Row>();
      for (const a of accounts!) {
        for (const p of accountHistory?.series[String(a.id)] ?? []) {
          const row = rows.get(p.date) ?? { date: p.date };
          row[`a${a.id}`] = p.balance;
          rows.set(p.date, row);
        }
      }
      return [...rows.values()].sort((x, y) => x.date.localeCompare(y.date));
    }
    return (trend?.series ?? []).map((p) => {
      const row: Row = { date: p.date };
      for (const k of KINDS) row[k.key] = p[k.key];
      return row;
    });
  }, [account, accounts, perAccount, accountHistory, trend?.series]);
  // A kind with nothing in it for the whole range has no line worth a legend
  // entry: most people have no loan, and many no mortgage account.
  const kinds = useMemo((): { key: LineKey; label: string; color: string }[] => {
    const typed = KINDS.map((k, i) => ({ ...k, color: slotColor(i, dark) }));
    if (account) {
      // The account takes its type's colour when the tab names the type.
      const color = typed.find((k) => k.group === only)?.color ?? slotColor(0, dark);
      return series.length ? [{ key: "account", label: account.name, color }] : [];
    }
    if (perAccount) {
      const info = new Map((allAccounts ?? []).map((a) => [a.id, a]));
      const lastOf = (key: LineKey) => {
        for (let i = series.length - 1; i >= 0; i--) if (series[i][key] != null) return Math.abs(series[i][key]!);
        return 0;
      };
      // Largest balance first: the first FIRST_LINES are drawn, the rest
      // wait behind "+N more".
      return accounts!
        .filter((a) => series.some((p) => p[`a${a.id}`] != null))
        .map((a) => {
          const acct = info.get(a.id);
          return {
            key: `a${a.id}` as const, label: shortAccountName(a.name), fullName: a.name, color: a.color,
            institution: acct?.institution_name ?? null,
          };
        })
        .sort((x, y) => lastOf(y.key) - lastOf(x.key));
    }
    return typed.filter(
      (k) => (only ? k.group === only : true) && series.some((p) => Math.abs(p[k.key] ?? 0) >= 0.5),
    );
  }, [series, only, account, accounts, perAccount, dark, allAccounts]);
  const visible = (key: LineKey, rank: number) => picked.get(key) ?? !(perAccount && rank >= FIRST_LINES);
  const shownKeys = new Set(kinds.filter((k, i) => visible(k.key, i)).map((k) => k.key));
  // Half the width of the trend chart on Portfolio, so half the date labels.
  const ticks = useMemo(
    () => evenTicks(series, "date", Math.min(4, dateTickCount(isMobile))),
    [series, isMobile],
  );
  const first = series[0];
  const last = series[series.length - 1];

  const span = spanInDays(first?.date, last?.date);
  const yAxis = niceMoneyAxis(
    series.flatMap((row) => kinds.filter((k) => shownKeys.has(k.key)).map((k) => (row as Row)[k.key])),
  );
  const toggle = (key: LineKey) =>
    setPicked((prev) => new Map(prev).set(key, !shownKeys.has(key)));

  const renderTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload as Row;
    return (
      <div className="rounded-lg border border-border bg-card px-2.5 py-2 text-xs shadow-md">
        <p className="text-muted-foreground mb-1">{formatDate(String(label))}</p>
        {kinds.filter((k) => shownKeys.has(k.key)).map((k) => (
          <p key={k.key} className="flex items-center justify-between gap-4 tabular-nums">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: k.color }} />
              {k.label}
            </span>
            <span className="font-medium">{formatCurrency(point[k.key] ?? 0)}</span>
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="min-w-0 truncate text-sm font-medium text-muted-foreground">
          {title ?? (account
            ? `${account.name} balance`
            : perAccount ? "Balances by account"
            : only && kinds.length === 1 ? `${kinds[0].label} balance` : "Balances by account type")}
        </h3>
        {ownRange && (
          <div className="flex items-center gap-2">
            {zoom.resetButton}
            <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center" style={{ height }}>
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      ) : kinds.length === 0 ? (
        <p className="flex items-center justify-center text-center text-sm text-muted-foreground" style={{ height }}>
          No balance history in this period.
        </p>
      ) : (
        <div {...zoom.wrapperProps}>
          <ResponsiveContainer width="100%" height={height}>
            <LineChart data={series} margin={{ top: 4, right: 16, left: 0, bottom: 0 }} {...zoom.chartProps}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(d) => formatAxisDate(d, span)} ticks={ticks} interval={0} />
              <YAxis tickFormatter={yAxis?.tickFormatter} ticks={yAxis?.ticks} domain={yAxis?.domain} tick={{ fontSize: 10 }} width={56} />
              <Tooltip content={renderTooltip} />
              {zoom.area}
              {kinds.map((k) => (
                <Line
                  key={k.key}
                  type="monotone"
                  dataKey={k.key}
                  stroke={k.color}
                  strokeWidth={hovered === k.key ? 3.5 : 2}
                  strokeOpacity={hovered && hovered !== k.key ? 0.25 : 1}
                  dot={false}
                  isAnimationActive={false}
                  hide={!shownKeys.has(k.key)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          {/* The legend switches each line, which is also how a small balance
              is read beside a large one: hide the large and the axis refits. */}
          <div className={cn(
            "mt-2 items-center gap-x-4 gap-y-1",
            // Two columns of short entries for accounts, so five take three rows.
            perAccount ? "grid grid-cols-2" : "flex flex-wrap justify-center",
          )}>
            {kinds.slice(0, perAccount ? FIRST_LINES : kinds.length).map((k) => (
              <LegendEntry key={k.key} k={k} on={shownKeys.has(k.key)} byAccount={byAccount}
                last={last[k.key]} first={first[k.key]} onToggle={() => toggle(k.key)}
                onHover={(h) => setHovered(h ? k.key : null)} />
            ))}
            {perAccount && kinds.length > FIRST_LINES && (
              <Popover
                open={moreOpen}
                onOpenChange={setMoreOpen}
                label="More accounts"
                align="right"
                trigger={
                  <button type="button" onClick={() => setMoreOpen((o) => !o)}
                    className="rounded px-1.5 py-0.5 text-xs font-medium text-primary hover:underline">
                    +{kinds.length - FIRST_LINES} more
                  </button>
                }
              >
                <p className="mb-1 text-xs text-muted-foreground">Pick the accounts to draw.</p>
                <div className="space-y-0.5">
                  {kinds.slice(FIRST_LINES).map((k) => (
                    <LegendEntry key={k.key} k={k} on={shownKeys.has(k.key)} byAccount
                      last={last[k.key]} first={first[k.key]} onToggle={() => toggle(k.key)}
                      onHover={(h) => setHovered(h ? k.key : null)} />
                  ))}
                </div>
              </Popover>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** How many accounts are drawn before the rest wait behind "+N more". */
const FIRST_LINES = 5;

/** A name short enough for a legend: the name itself when it
 *  is short, else cut to fit. */
function shortAccountName(name: string): string {
  if (name.length <= 18) return name;
  return `${name.slice(0, 16).trimEnd()}\u2026`;
}

type LegendKind = { key: LineKey; label: string; color: string; fullName?: string; institution?: string | null };

/** One legend entry: switches its line, and on hover picks it out. */
function LegendEntry({ k, on, byAccount, last, first, onToggle, onHover }: {
  k: LegendKind;
  on: boolean;
  byAccount: boolean;
  last: number | undefined;
  first: number | undefined;
  onToggle: () => void;
  onHover: (hovering: boolean) => void;
}) {
  const change = (last ?? 0) - (first ?? 0);
  const flat = Math.abs(change) < 0.5;
  const name = k.fullName ?? k.label;
  const changeText = flat ? "no change" : `${change > 0 ? "+" : "\u2212"}${formatCurrency(Math.abs(change))}`;
  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => on && onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => on && onHover(true)}
      onBlur={() => onHover(false)}
      aria-pressed={on}
      title={`${on ? "Hide" : "Show"} ${byAccount ? name : name.toLowerCase()}${k.fullName ? ` (${changeText} over these dates)` : ""}`}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-xs tabular-nums transition-opacity",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        !on && "opacity-50",
      )}
    >
      <span className="h-2 w-2 rounded-full shrink-0" style={{ background: k.color }} />
      {k.fullName && <AccountLogo size="sm" />}
      <span className={cn("truncate text-foreground", !on && "line-through")}>{k.label}</span>
      <span className="font-medium text-foreground">{formatCurrency(last ?? 0)}</span>
      {/* An account entry keeps to name and balance so two fit side by side;
          its change is in the hover text. */}
      {!k.fullName && <span className="hidden text-muted-foreground sm:inline">{changeText}</span>}
    </button>
  );
}

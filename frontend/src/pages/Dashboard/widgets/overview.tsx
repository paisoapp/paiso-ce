import { AssetBreakdownDonut } from "@/components/portfolio/AssetBreakdownDonut";
import { NetWorthTrendChart } from "@/components/portfolio/NetWorthTrendChart";
import { BalanceTrendCard } from "@/components/portfolio/BalanceTrendCard";
import { useDashboardData } from "@/hooks/useDashboard";
import { usePortfolioBreakdown } from "@/hooks/usePortfolio";
import { Link } from "react-router-dom";
import { accountHref } from "@/lib/navTargets";
import { formatCurrency, cn } from "@/lib/utils";
import { EmptyState, StatCard, WidgetCard, WidgetSkeleton } from "./common";

// ── Stat cards ──────────────────────────────────────────────────────────────

export function NetWorthStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return <StatCard label="Net Worth" value={formatCurrency(data.net_worth)} to="/portfolio" />;
}

export function TotalAssetsStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return <StatCard label="Total Assets" value={formatCurrency(data.total_assets)} to="/portfolio#account-details" />;
}

export function TotalLiabilitiesStat() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return (
    <StatCard
      label="Total Liabilities"
      value={formatCurrency(data.total_liabilities)}
      accent={data.total_liabilities > 0 ? "text-destructive" : undefined}
      to="/portfolio#liabilities"
    />
  );
}

// ── Charts ──────────────────────────────────────────────────────────────────

export function NetWorthTrendWidget() {
  return <NetWorthTrendChart className="h-full" to="/portfolio" rangeSection="dashboard" />;
}

/** The same chart, opened on the two lines the net worth figure is made of —
 *  for seeing whether a change came from what is owned or what is owed. */
export function AssetsLiabilitiesTrendWidget() {
  return (
    <NetWorthTrendChart
      className="h-full"
      to="/portfolio"
      rangeSection="dashboard"
      title="Assets & Liabilities"
      prefsKey="dashboard-balance"
      defaultHidden={["net_worth"]}
    />
  );
}

/** The same figures as bars: what is owned above the line, what is owed below
 *  it, and net worth drawn across them. */
export function NetWorthBarsWidget() {
  return (
    <NetWorthTrendChart
      className="h-full"
      to="/portfolio"
      rangeSection="dashboard"
      title="Net Worth Makeup"
      prefsKey="dashboard-bars"
      chart="bar"
    />
  );
}

/** Today's balance sheet as a flow: assets by kind, into what is owed and
 *  what is left. */
export function NetWorthFlowWidget() {
  return (
    <NetWorthTrendChart
      className="h-full"
      to="/portfolio"
      rangeSection="dashboard"
      title="Net Worth Flow"
      prefsKey="dashboard-flow"
      chart="sankey"
    />
  );
}

/** Cash, investments and each kind of debt, as one line apiece. */
export function BalanceTrendWidget() {
  return <BalanceTrendCard className="h-full" ownRange title="Balances by Account Type" />;
}

export function AssetMixWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  return (
    <AssetBreakdownDonut
      title="Asset Mix"
      breakdown={data.asset_breakdown}
      total={data.total_assets}
      height={180}
      className="h-full"
      to="/portfolio"
    />
  );
}

export function BalanceSheetWidget() {
  const { data } = useDashboardData();
  if (!data) return <WidgetSkeleton />;
  const rows = [
    { label: "Total Assets", value: data.total_assets, color: "bg-success" },
    { label: "Total Liabilities", value: data.total_liabilities, color: "bg-destructive" },
    { label: "Net Worth", value: data.net_worth, color: "bg-primary" },
  ];
  return (
    <WidgetCard title="Balance Sheet" to="/portfolio">
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-center justify-between text-sm mb-1">
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-medium tabular-nums">{formatCurrency(row.value)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full ${row.color}`}
                style={{ width: `${Math.max(0, Math.min(100, (row.value / Math.max(data.total_assets, 1)) * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </WidgetCard>
  );
}

// ── Account summary table ───────────────────────────────────────────────────

interface SummaryRow {
  label: string;
  count: number;
  total: number;
  side: "asset" | "liability";
  /** The Portfolio section table this group expands into. */
  section: string;
}

/** Every account group on one table, with its share of assets or debts. The
 *  groups and their totals match the Portfolio page's section tables. */
export function AccountSummaryWidget() {
  const { data: bd } = usePortfolioBreakdown();
  const { data: dash } = useDashboardData();
  if (!bd || !dash) return <WidgetSkeleton />;

  const counted = <T extends { exclude_from_net_worth?: boolean }>(rows: T[]) =>
    rows.filter((r) => !r.exclude_from_net_worth);
  const assetLoans = [...counted(bd.mortgages), ...counted(bd.other_assets)].filter((r) => r.loan_balance > 0);

  const groups: SummaryRow[] = [
    { label: "Cash & Bank", side: "asset", section: "cash", count: bd.cash.length,
      total: bd.cash.reduce((s, r) => s + (r.balance ?? 0), 0) },
    { label: "Investments", side: "asset", section: "investments", count: bd.investments.length,
      total: bd.investments.reduce((s, r) => s + (r.value ?? 0), 0) },
    { label: "Property", side: "asset", section: "property", count: counted(bd.mortgages).length,
      total: counted(bd.mortgages).reduce((s, r) => s + (r.property_value ?? r.value ?? 0), 0) },
    { label: "Other Assets", side: "asset", section: "other-assets", count: counted(bd.other_assets).length,
      total: counted(bd.other_assets).reduce((s, r) => s + (r.value ?? 0), 0) },
    { label: "Credit Cards", side: "liability", section: "credit-cards", count: bd.credit_cards.length,
      total: bd.credit_cards.reduce((s, r) => s + Math.abs(r.balance ?? 0), 0) },
    { label: "Loan Accounts", side: "liability", section: "loans", count: bd.loans.length,
      total: bd.loans.reduce((s, r) => s + Math.abs(r.balance ?? 0), 0) },
    { label: "Mortgages & Asset Loans", side: "liability", section: "property", count: assetLoans.length,
      total: assetLoans.reduce((s, r) => s + r.loan_balance, 0) },
  ];
  const rows = groups.filter((r) => r.count > 0);

  if (rows.length === 0) {
    return (
      <WidgetCard title="Account Summary">
        <EmptyState>Link or add an account to see it here.</EmptyState>
      </WidgetCard>
    );
  }

  const pct = (r: SummaryRow) => {
    const denom = r.side === "asset" ? dash.total_assets : dash.total_liabilities;
    return denom > 0 ? `${((r.total / denom) * 100).toFixed(1)}%` : "—";
  };

  return (
    <WidgetCard title="Account Summary" to="/portfolio#account-details">
      {/* At phone width the count column goes and "of assets" moves under
          the share, so every column fits without sideways scrolling. */}
      <div className="-mx-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="px-3 sm:px-4 py-1.5 text-left font-medium">Group</th>
              <th className="hidden sm:table-cell px-4 py-1.5 text-right font-medium">Accounts</th>
              <th className="px-3 sm:px-4 py-1.5 text-right font-medium">Balance</th>
              <th className="px-3 sm:px-4 py-1.5 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.label} className="hover:bg-muted/40">
                <td className="px-3 sm:px-4 py-2 font-medium">
                  <Link to={`/portfolio#section-${r.section}`} className="hover:underline">{r.label}</Link>
                  <span className="block sm:hidden text-xs font-normal text-muted-foreground">
                    {r.count} account{r.count === 1 ? "" : "s"}
                  </span>
                </td>
                <td className="hidden sm:table-cell px-4 py-2 text-right tabular-nums text-muted-foreground">{r.count}</td>
                <td className={cn("px-3 sm:px-4 py-2 text-right tabular-nums font-medium whitespace-nowrap", r.side === "liability" && "text-destructive")}>
                  {r.side === "liability" ? "−" : ""}{formatCurrency(r.total)}
                </td>
                <td className="px-3 sm:px-4 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {pct(r)}
                  <span className="text-[10px] block sm:inline sm:ml-1">of {r.side === "asset" ? "assets" : "debts"}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border">
            <tr>
              <td className="px-3 sm:px-4 py-2 font-semibold">Net Worth</td>
              <td className="hidden sm:table-cell" />
              <td className="px-3 sm:px-4 py-2 text-right tabular-nums font-semibold whitespace-nowrap">{formatCurrency(dash.net_worth)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </WidgetCard>
  );
}

// ── Debt overview ───────────────────────────────────────────────────────────

export function DebtOverviewWidget() {
  const { data: bd } = usePortfolioBreakdown();
  if (!bd) return <WidgetSkeleton />;

  const debts = [
    ...bd.credit_cards.map((r) => ({ key: `cc-${r.id}`, name: r.name, kind: "Credit card",
      amount: Math.abs(r.balance ?? 0), to: accountHref("credit_card", r.id) })),
    ...bd.loans.map((r) => ({ key: `ln-${r.id}`, name: r.name, kind: r.type_label,
      amount: Math.abs(r.balance ?? 0), to: accountHref(r.type, r.id) })),
    ...[...bd.mortgages, ...bd.other_assets]
      .filter((r) => !r.exclude_from_net_worth && r.loan_balance > 0)
      .map((r) => ({ key: `as-${r.id}`, name: r.name, kind: "Mortgage / asset loan", amount: r.loan_balance,
        to: r.type === "primary_home" || r.type === "rental" ? "/investments/property" : "/investments/other" })),
  ].filter((d) => d.amount > 0).sort((a, b) => b.amount - a.amount);

  const total = debts.reduce((s, d) => s + d.amount, 0);

  return (
    <WidgetCard title="Debt Overview" to="/portfolio#liabilities">
      {debts.length === 0 ? (
        <EmptyState>No debts on file.</EmptyState>
      ) : (
        <div className="space-y-2">
          <p className="text-lg font-bold tabular-nums text-destructive">{formatCurrency(total)}</p>
          <ul className="space-y-2">
            {debts.slice(0, 6).map((d) => (
              <li key={d.key}>
                <Link to={d.to} className="block rounded px-1 -mx-1 py-0.5 hover:bg-muted/60">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate">
                    {d.name} <span className="text-xs text-muted-foreground">· {d.kind}</span>
                  </span>
                  <span className="tabular-nums font-medium ml-2">{formatCurrency(d.amount)}</span>
                </div>
                <div className="h-1 rounded-full bg-muted overflow-hidden mt-1">
                  <div className="h-full rounded-full bg-destructive/70" style={{ width: `${(d.amount / total) * 100}%` }} />
                </div>
                </Link>
              </li>
            ))}
          </ul>
          {debts.length > 6 && (
            <p className="text-xs text-muted-foreground">+{debts.length - 6} more</p>
          )}
        </div>
      )}
    </WidgetCard>
  );
}

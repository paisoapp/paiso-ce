import { useMemo } from "react";
import { Rectangle, ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { usePortfolioBreakdown, usePortfolioSummary } from "@/hooks/usePortfolio";
import { assetSlices } from "@/lib/assetColors";
import { neutral } from "@/lib/chartPalette";
import { formatCurrency } from "@/lib/utils";
import { useIsDarkMode } from "@/store/theme";

// Liabilities take the amber the trend chart already gives them, in three
// steps, so a debt is never drawn in a colour an asset uses. Net worth takes
// the success green, and a shortfall the destructive red: those two are about
// polarity, which is what those tokens mean everywhere else.
const OWED = { light: "#d97706", dark: "#f59e0b" };
const OWED_KINDS = {
  credit_cards: { light: "#f59e0b", dark: "#fbbf24" },
  mortgages: { light: "#b45309", dark: "#d97706" },
  loans: { light: "#92400e", dark: "#b45309" },
};
const NET = { light: "#15803d", dark: "#4ade80" };
const SHORT = { light: "#dc2626", dark: "#f87171" };

type Side = "source" | "assets" | "result" | "owed";

interface NodeDatum {
  name: string;
  color: string;
  side: Side;
}

interface Graph {
  nodes: NodeDatum[];
  links: { source: number; target: number; value: number }[];
}

/** The balance sheet as a flow: each kind of asset into Assets, which splits
 *  into what is owed, by kind of debt, and what is left, the net worth.
 *
 *  Every figure is from the portfolio summary, so the diagram adds up to the
 *  headline numbers on the same page. It is today's position and has no date
 *  range. */
export function NetWorthSankey({ height = 320 }: { height?: number }) {
  const dark = useIsDarkMode();
  const { data: summary, isLoading } = usePortfolioSummary();
  const { data: breakdown } = usePortfolioBreakdown();

  const graph = useMemo((): Graph | null => {
    if (!summary) return null;
    const pick = (c: { light: string; dark: string }) => (dark ? c.dark : c.light);
    const assets = assetSlices(summary.asset_breakdown, dark);
    const totalAssets = assets.reduce((s, a) => s + a.value, 0);

    // The summary keeps loans against a property apart from loan accounts, and
    // counts mortgage accounts among the latter. The account list says which
    // of those accounts are mortgages, so they can sit with the other
    // mortgages; without it they stay under Loans, and the total is the same.
    const mortgageAccounts = Math.min(
      summary.total_loan_account_balance,
      (breakdown?.loans ?? [])
        .filter((r) => r.type === "mortgage")
        .reduce((s, r) => s + Math.abs(r.balance ?? 0), 0),
    );
    const owed = [
      { name: "Credit cards", value: summary.total_cc_balance, color: pick(OWED_KINDS.credit_cards) },
      { name: "Mortgages", value: summary.total_loan_balance + mortgageAccounts, color: pick(OWED_KINDS.mortgages) },
      { name: "Loans", value: summary.total_loan_account_balance - mortgageAccounts, color: pick(OWED_KINDS.loans) },
    ].filter((o) => o.value >= 0.5);
    const totalOwed = owed.reduce((s, o) => s + o.value, 0);
    if (totalAssets < 0.5 && totalOwed < 0.5) return null;

    const nodes: NodeDatum[] = [];
    const links: Graph["links"] = [];
    const add = (n: NodeDatum) => nodes.push(n) - 1;
    const link = (source: number, target: number, value: number) => {
      if (value >= 0.5) links.push({ source, target, value });
    };

    const hub = totalAssets >= 0.5 ? add({ name: "Assets", color: neutral(dark), side: "assets" }) : -1;
    for (const a of assets) link(add({ name: a.label, color: a.color, side: "source" }), hub, a.value);

    const net = totalAssets - totalOwed;
    if (net >= 0.5) link(hub, add({ name: "Net worth", color: pick(NET), side: "result" }), net);

    if (totalOwed >= 0.5) {
      const owedHub = add({ name: "Liabilities", color: pick(OWED), side: "result" });
      if (hub >= 0) link(hub, owedHub, Math.min(totalAssets, totalOwed));
      // Owing more than is owned: the part no asset covers comes in from its
      // own node, so the debts still add up to what is owed.
      if (net <= -0.5) {
        link(add({ name: "Shortfall", color: pick(SHORT), side: "source" }), owedHub, -net);
      }
      for (const o of owed) link(owedHub, add({ name: o.name, color: o.color, side: "owed" }), o.value);
    }
    return { nodes, links };
  }, [summary, breakdown, dark]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (!graph) {
    return (
      <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>
        Nothing to show yet. Add an account to see how your net worth is made up.
      </div>
    );
  }

  const rows = Math.max(
    graph.nodes.filter((n) => n.side === "source").length,
    graph.nodes.filter((n) => n.side === "owed").length + 1,
  );
  // The labels either side need room, so on a narrow screen the diagram keeps
  // its width inside a sideways scroller, as the Cash Flow one does.
  return (
    <div className="overflow-x-auto">
      <div style={{ minWidth: 560 }}>
        <ResponsiveContainer width="100%" height={Math.max(height, rows * 40)}>
          <Sankey
            data={graph}
            nodeWidth={12}
            nodePadding={20}
            margin={{ top: 22, right: 120, bottom: 10, left: 120 }}
            node={<Node {...({} as NodeProps)} />}
            link={<Link {...({} as LinkProps)} />}
          >
            <Tooltip isAnimationActive={false} content={<FlowTooltip />} />
          </Sankey>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface NodeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  payload: NodeDatum & { value: number };
}

function Node({ x, y, width, height, payload }: NodeProps) {
  const bar = <Rectangle x={x} y={y} width={width} height={height} fill={payload.color} fillOpacity={0.9} radius={2} />;
  // The two hubs in the middle carry their label above the bar, clear of the
  // links running either side of them.
  if (payload.side === "assets" || payload.name === "Liabilities") {
    return (
      <g>
        {bar}
        <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={10}>
          <tspan fill="hsl(var(--foreground))" fontWeight={600}>{payload.name}</tspan>
          <tspan fill="hsl(var(--muted-foreground))" dx={5}>{formatCurrency(payload.value)}</tspan>
        </text>
      </g>
    );
  }
  const left = payload.side === "source";
  const labelX = left ? x - 6 : x + width + 6;
  const cy = y + height / 2;
  return (
    <g>
      {bar}
      {height >= 6 && (
        <text x={labelX} textAnchor={left ? "end" : "start"} fontSize={10}>
          <tspan x={labelX} y={cy - 4} fill="hsl(var(--foreground))" fontWeight={payload.name === "Net worth" ? 700 : 500}>
            {payload.name}
          </tspan>
          <tspan x={labelX} y={cy + 8} fill="hsl(var(--muted-foreground))">{formatCurrency(payload.value)}</tspan>
        </text>
      )}
    </g>
  );
}

interface LinkProps {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  payload: { source: NodeDatum; target: NodeDatum };
}

/** A link is coloured by its more specific end: the asset it comes from, or
 *  the debt or net worth it goes to. */
function specificEnd({ source, target }: { source: NodeDatum; target: NodeDatum }): NodeDatum {
  return source.side === "source" ? source : target;
}

function Link({ sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload }: LinkProps) {
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={specificEnd(payload).color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={0.25}
    />
  );
}

interface TooltipItem {
  name?: string;
  value?: number;
  payload?: { payload?: { name?: string; value?: number; source?: NodeDatum; target?: NodeDatum } };
}

function FlowTooltip({ active, payload }: { active?: boolean; payload?: TooltipItem[] }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const inner = item.payload?.payload;
  const label =
    inner?.source && inner?.target
      ? specificEnd({ source: inner.source, target: inner.target }).name
      : item.name ?? inner?.name ?? "";
  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-md">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">: {formatCurrency(item.value ?? inner?.value ?? 0)}</span>
    </div>
  );
}

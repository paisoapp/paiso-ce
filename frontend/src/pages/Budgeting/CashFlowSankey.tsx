import { useMemo } from "react";
import { ResponsiveContainer, Sankey, Tooltip, Rectangle } from "recharts";
import type { CategoryTotal } from "@/hooks/useBudget";
import { formatCurrency } from "@/lib/utils";
import { MAX_SLOTS, assignSlots, neutral, slotColor } from "./colors";
import { useIsDarkMode } from "@/store/theme";

export interface SelectedCategory {
  id: number;
  name: string;
}

// The hub, the savings outlet and the deficit inlet are *not* categories, so
// they are deliberately outside the categorical order — a reader should never
// have to wonder whether "Cash Flow" is a spending category that happens to be
// blue. They take ink from the neutral, and their meaning comes from position
// and label.
//
// Net Savings keeps a positive-sounding green because it is the one node whose
// *polarity* is the point; it is the app's success token, not a series hue.
const SAVINGS_COLOR = { light: "#15803d", dark: "#4ade80" };

// Only the largest categories get their own node; the long tail of small ones
// is rolled into a single "Other" node per side.
//
// Capped at the number of hues in the palette rather than at an arbitrary 12.
// Categorical hues are assigned in a fixed order and never cycled, so a 13th
// category could only be given a colour already in use on the same side —
// which is exactly the ambiguity the fold into "Other" exists to prevent.
const MAX_VISIBLE = MAX_SLOTS;
const MIN_SHARE = 0.015;

type NodeKind =
  | "income"
  | "hub"
  | "expense"
  | "savings"
  | "deficit";

interface SankeyNodeDatum {
  name: string;
  color: string;
  kind: NodeKind;
  /** Set for individual category nodes; null for hub / Other / savings / deficit. */
  categoryId: number | null;
}

interface SankeyLinkDatum {
  source: number;
  target: number;
  value: number;
}

interface AggRow {
  key: string;
  categoryId: number | null;
  name: string;
  /** The category's stored colour. Deliberately unused for the chart — see
   *  `hueFor` — but kept so a future "use my category colours" option has it. */
  color: string | null;
  total: number;
}

/** Group rows by their assigned category, dropping zero-value rows. */
function aggregate(rows: CategoryTotal[]): AggRow[] {
  const agg = new Map<string, AggRow>();
  for (const r of rows) {
    if (r.total === 0) continue;
    const key = r.category_id == null ? "uncat" : String(r.category_id);
    const prev = agg.get(key);
    if (prev) prev.total += r.total;
    else agg.set(key, { key, categoryId: r.category_id, name: r.category_name, color: r.color, total: r.total });
  }
  return Array.from(agg.values()).sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

/**
 * Collapse the long tail of small categories (already sorted descending) into a
 * single "Other" row, keeping at most MAX_VISIBLE meaningful nodes. A lone
 * leftover is kept as-is rather than relabelled "Other".
 */
function condense(rows: AggRow[]): AggRow[] {
  const grandTotal = rows.reduce((s, r) => s + Math.abs(r.total), 0);
  const visible: AggRow[] = [];
  const rest: AggRow[] = [];
  rows.forEach((r, i) => {
    const share = grandTotal > 0 ? Math.abs(r.total) / grandTotal : 0;
    if (i < MAX_VISIBLE && share >= MIN_SHARE) visible.push(r);
    else rest.push(r);
  });
  if (rest.length === 1) {
    visible.push(rest[0]);
  } else if (rest.length > 1) {
    const total = rest.reduce((s, r) => s + r.total, 0);
    visible.push({ key: "__other__", categoryId: null, name: `Other (${rest.length})`, color: null, total });
  }
  return visible;
}

/** Build the Recharts Sankey `{ nodes, links }` graph for the period. */
function buildGraph(
  incomeRows: CategoryTotal[],
  expenseRows: CategoryTotal[],
  dark: boolean,
): { nodes: SankeyNodeDatum[]; links: SankeyLinkDatum[] } {
  const income = condense(aggregate(incomeRows));
  const expenses = condense(aggregate(expenseRows));

  // Income and expenses each walk the fixed hue order from the start. They are
  // separated by the hub and never adjacent, so the order's separation
  // guarantees hold within each column — which is where nodes actually touch.
  // A hue may appear on both sides; direction, position and the node's own
  // label distinguish them, and colour is not carrying that load.
  const incomeSlots = assignSlots(income.map((r) => r.categoryId));
  const expenseSlots = assignSlots(expenses.map((r) => r.categoryId));

  const hueFor = (row: AggRow, slots: Map<number, number>): string => {
    // "Other" and the uncategorized bucket are not one thing, so they get the
    // neutral rather than a hue that would imply they are.
    if (row.categoryId == null) return neutral(dark);
    const slot = slots.get(row.categoryId);
    return slot == null ? neutral(dark) : slotColor(slot, dark);
  };

  const totalIncome = income.reduce((s, r) => s + r.total, 0);
  const totalExpenses = expenses.reduce((s, r) => s + Math.abs(r.total), 0);
  const net = totalIncome - totalExpenses;

  const nodes: SankeyNodeDatum[] = [];
  const links: SankeyLinkDatum[] = [];

  // Left column: income sources.
  income.forEach((r) => {
    const idx = nodes.length;
    nodes.push({ name: r.name, color: hueFor(r, incomeSlots), kind: "income", categoryId: r.categoryId });
    links.push({ source: idx, target: -1, value: r.total }); // target patched below
  });

  // Center: the cash-flow hub.
  const hubIndex = nodes.length;
  nodes.push({ name: "Cash Flow", color: neutral(dark), kind: "hub", categoryId: null });
  links.forEach((l) => { if (l.target === -1) l.target = hubIndex; });

  // When spending exceeds income, add a balancing inflow so the graph closes.
  if (net < 0) {
    const deficitIdx = nodes.length;
    nodes.push({ name: "Net Deficit", color: neutral(dark), kind: "deficit", categoryId: null });
    links.push({ source: deficitIdx, target: hubIndex, value: -net });
  }

  // Right column: expense categories.
  expenses.forEach((r) => {
    const idx = nodes.length;
    nodes.push({ name: r.name, color: hueFor(r, expenseSlots), kind: "expense", categoryId: r.categoryId });
    links.push({ source: hubIndex, target: idx, value: Math.abs(r.total) });
  });

  // Leftover income flows into savings.
  if (net > 0) {
    const savingsIdx = nodes.length;
    nodes.push({ name: "Net Savings", color: dark ? SAVINGS_COLOR.dark : SAVINGS_COLOR.light, kind: "savings", categoryId: null });
    links.push({ source: hubIndex, target: savingsIdx, value: net });
  }

  return { nodes, links };
}

// ── Custom renderers ──────────────────────────────────────────────────────────

interface NodeProps {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  payload: SankeyNodeDatum & { value: number };
  selectedId?: number | null;
  onSelect?: (c: SelectedCategory) => void;
  priorOf?: PriorLookup;
}

/** What a node was worth in the comparison period, or undefined when the node
 *  has no counterpart there to be compared with (the hub, "Other", a
 *  subcategory). Zero is an answer: the category is new this period. */
type PriorLookup = (node: SankeyNodeDatum) => number | undefined;

/** More income or savings is good news; more spending is not. */
function changeTone(kind: NodeKind, change: number): string {
  const good = kind === "expense" ? change < 0 : change > 0;
  return good ? "hsl(var(--success))" : "hsl(var(--destructive))";
}

function truncate(s: string, max = 18) {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function SankeyNode({ x, y, width, height, payload, selectedId, onSelect, priorOf }: NodeProps) {
  // The central hub keeps its label above the bar so it never collides with the
  // expense labels to its right (matters on narrow widths).
  if (payload.kind === "hub") {
    const cx = x + width / 2;
    return (
      <g>
        <Rectangle x={x} y={y} width={width} height={height} fill={payload.color} fillOpacity={0.9} radius={2} />
        <text x={cx} y={y - 6} textAnchor="middle" fontSize={10}>
          <tspan fill="hsl(var(--foreground))" fontWeight={600}>{payload.name}</tspan>
          <tspan fill="hsl(var(--muted-foreground))" dx={5}>{formatCurrency(payload.value)}</tspan>
        </text>
      </g>
    );
  }

  const clickable = payload.categoryId != null;
  const isSelected = clickable && payload.categoryId === selectedId;
  const dim = selectedId != null && !isSelected;
  const handleClick = clickable && onSelect
    ? () => onSelect({ id: payload.categoryId as number, name: payload.name })
    : undefined;

  const isLeft =
    payload.kind === "income" ||
    payload.kind === "deficit";
  const labelX = isLeft ? x - 6 : x + width + 6;
  const anchor = isLeft ? "end" : "start";
  const cy = y + height / 2;
  // Hide labels for slivers too short to read without colliding with
  // neighbours.
  const showLabel = height >= 6;
  // The change rides on the amount's line rather than a third one: a third
  // line would run into the next node's label wherever nodes sit close.
  const prior = priorOf?.(payload);
  const change = prior === undefined ? 0 : payload.value - prior;
  const showChange = prior !== undefined && Math.abs(change) >= 0.5;
  return (
    <g onClick={handleClick} style={{ cursor: clickable ? "pointer" : "default" }}>
      <Rectangle x={x} y={y} width={width} height={height} fill={payload.color} fillOpacity={dim ? 0.3 : 0.9} radius={2} />
      {showLabel && (
        // Name and amount stacked on two lines so labels stay narrow and don't clip.
        <text x={labelX} textAnchor={anchor} fontSize={10} opacity={dim ? 0.45 : 1}>
          <tspan x={labelX} y={cy - 4} fill="hsl(var(--foreground))" fontWeight={isSelected ? 700 : 500}>{truncate(payload.name)}</tspan>
          <tspan x={labelX} y={cy + 8} fill="hsl(var(--muted-foreground))">{formatCurrency(payload.value)}</tspan>
          {showChange && (
            <tspan dx={4} fill={changeTone(payload.kind, change)}>
              {change > 0 ? "▲" : "▼"} {formatCurrency(Math.abs(change))}
            </tspan>
          )}
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
  index: number;
  payload: { source: SankeyNodeDatum; target: SankeyNodeDatum };
  selectedId?: number | null;
}

/** The end of a link worth naming: whichever end is not the hub. */
function linkCategory(payload: { source: SankeyNodeDatum; target: SankeyNodeDatum }): SankeyNodeDatum {
  return payload.source.kind === "hub" ? payload.target : payload.source;
}

function SankeyLink(props: LinkProps) {
  const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX, linkWidth, payload, selectedId } = props;
  const cat = linkCategory(payload);
  const related = selectedId == null || cat.categoryId === selectedId;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={cat.color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={related ? 0.25 : 0.05}
    />
  );
}

/** The inner datum Recharts nests at payload[0].payload.payload (node datum, or
 *  a link whose source/target have been resolved to node objects). */
interface TooltipInner {
  name?: string;
  value?: number;
  source?: SankeyNodeDatum;
  target?: SankeyNodeDatum;
}

interface TooltipItem {
  name?: string;
  value?: number;
  payload?: { payload?: TooltipInner };
}

/**
 * Tooltip showing just the category name and amount — e.g. "Mortgages: $4,000",
 * never "Cash Flow - Mortgages". Works for both node and link hovers.
 */
function SankeyTooltip({ active, payload, priorOf }: { active?: boolean; payload?: TooltipItem[]; priorOf?: PriorLookup }) {
  if (!active || !payload?.length) return null;
  const item = payload[0];
  const inner = item?.payload?.payload;
  const value = item?.value ?? inner?.value ?? 0;
  let label = item?.name ?? inner?.name ?? "";
  // A node hover carries the node itself; a link hover is about one of its ends.
  let node = inner as SankeyNodeDatum | undefined;
  // For links, drop the "Cash Flow" hub end and show only the category.
  if (inner?.source && inner?.target) {
    node = linkCategory({ source: inner.source, target: inner.target });
    label = node.name;
  }
  const prior = node?.kind ? priorOf?.(node) : undefined;
  const change = prior === undefined ? 0 : value - prior;

  return (
    <div className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs text-foreground shadow-md">
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">: {formatCurrency(value)}</span>
      {prior !== undefined && node && (
        <p className="mt-0.5 text-muted-foreground">
          {prior === 0 ? "Nothing in the comparison period" : `${formatCurrency(prior)} in the comparison period`}
          {prior > 0 && Math.abs(change) >= 0.5 && (
            <span style={{ color: changeTone(node.kind, change) }}>
              {" "}({change > 0 ? "+" : "−"}{Math.abs((change / prior) * 100).toFixed(0)}%)
            </span>
          )}
        </p>
      )}
    </div>
  );
}

export function CashFlowSankey({
  incomeRows,
  expenseRows,
  priorIncomeRows,
  priorExpenseRows,
  compact = false,
  isLoading,
  selectedId = null,
  onSelect,
}: {
  incomeRows: CategoryTotal[];
  expenseRows: CategoryTotal[];
  /** The comparison period's totals. With them, each category node carries
   *  its change, and categories that had activity then and none now are named
   *  under the diagram — a flow that has stopped has no ribbon to annotate. */
  priorIncomeRows?: CategoryTotal[];
  priorExpenseRows?: CategoryTotal[];
  /** A smaller diagram for a dashboard card: categories only, and sized to
   *  fit a half-width card without scrolling sideways. */
  compact?: boolean;
  isLoading: boolean;
  selectedId?: number | null;
  onSelect?: (c: SelectedCategory) => void;
}) {
  // The palette has separate steps for each surface; a dark chart is chosen,
  // not an automatic inversion of the light one.
  const dark = useIsDarkMode();
  const graph = useMemo(
    () => buildGraph(incomeRows, expenseRows, dark),
    [incomeRows, expenseRows, dark],
  );

  const comparing = !!priorIncomeRows && !!priorExpenseRows;
  const { priorOf, stopped } = useMemo(() => {
    if (!priorIncomeRows || !priorExpenseRows) return { priorOf: undefined, stopped: [] as { name: string; total: number }[] };
    const sumById = (rows: CategoryTotal[]) => {
      const m = new Map<number, number>();
      for (const r of rows) if (r.category_id != null) m.set(r.category_id, (m.get(r.category_id) ?? 0) + Math.abs(r.total));
      return m;
    };
    const priorIncome = sumById(priorIncomeRows);
    const priorExpense = sumById(priorExpenseRows);
    const total = (rows: CategoryTotal[]) => rows.reduce((s, r) => s + Math.abs(r.total), 0);
    const priorNet = total(priorIncomeRows) - total(priorExpenseRows);
    const lookup: PriorLookup = (node) => {
      if (node.kind === "savings") return Math.max(0, priorNet);
      if (node.categoryId == null) return undefined;
      if (node.kind === "income") return priorIncome.get(node.categoryId) ?? 0;
      if (node.kind === "expense") return priorExpense.get(node.categoryId) ?? 0;
      return undefined;
    };
    const active = (rows: CategoryTotal[]) => new Set(rows.filter((r) => r.total !== 0).map((r) => r.category_id));
    const nowIncome = active(incomeRows);
    const nowExpense = active(expenseRows);
    const gone = [
      ...priorIncomeRows.filter((r) => r.total !== 0 && !nowIncome.has(r.category_id)),
      ...priorExpenseRows.filter((r) => r.total !== 0 && !nowExpense.has(r.category_id)),
    ].map((r) => ({ name: r.category_name, total: Math.abs(r.total) })).sort((a, b) => b.total - a.total);
    return { priorOf: lookup, stopped: gone };
  }, [priorIncomeRows, priorExpenseRows, incomeRows, expenseRows]);

  if (isLoading) {
    return (
      <div className={`${compact ? "h-[280px]" : "h-[360px]"} flex items-center justify-center`}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (graph.links.length === 0) {
    return (
      <div className={`${compact ? "h-[280px]" : "h-[360px]"} flex items-center justify-center text-sm text-muted-foreground`}>
        No transactions in this period.
      </div>
    );
  }

  // Scale the height to the busiest column.
  const count = (...kinds: NodeKind[]) =>
    graph.nodes.filter((n) => kinds.includes(n.kind)).length;
  const rows = Math.max(count("income", "deficit"), count("expense", "savings"), 1);
  const height = compact
    ? Math.min(460, Math.max(320, rows * 38))
    : Math.min(1100, Math.max(360, rows * 34));

  // The change printed beside each amount needs the label margins widened.
  const minWidth = compact ? 440 : 700;
  const margin = compact
    ? { top: 24, right: 104, bottom: 8, left: 96 }
    : { top: 24, right: comparing ? 160 : 130, bottom: 12, left: comparing ? 150 : 120 };

  // The label margins need ~700px to stay readable, so on narrow screens the
  // diagram keeps its full width inside a horizontal scroller.
  return (
    <div>
      <div className="overflow-x-auto">
        <div style={{ minWidth }}>
          <ResponsiveContainer width="100%" height={height}>
            <Sankey
              data={graph}
              nodeWidth={12}
              nodePadding={18}
              margin={margin}
              node={<SankeyNode selectedId={selectedId} onSelect={onSelect} priorOf={priorOf} {...({} as NodeProps)} />}
              link={<SankeyLink selectedId={selectedId} {...({} as LinkProps)} />}
            >
              <Tooltip isAnimationActive={false} content={<SankeyTooltip priorOf={priorOf} />} />
            </Sankey>
          </ResponsiveContainer>
        </div>
      </div>
      {comparing && (
        <p className="mt-2 text-xs text-muted-foreground">
          ▲ ▼ show the change from the comparison period.
          {stopped.length > 0 && (
            <>
              {" "}No activity this period in:{" "}
              {stopped.slice(0, 6).map((s, i) => (
                <span key={s.name}>
                  {i > 0 && ", "}
                  <span className="text-foreground">{s.name}</span> ({formatCurrency(s.total)} before)
                </span>
              ))}
              {stopped.length > 6 && `, and ${stopped.length - 6} more`}.
            </>
          )}
        </p>
      )}
      {!compact && (
        <p className="md:hidden text-center text-[11px] text-muted-foreground mt-1">
          Swipe sideways to explore the full flow
        </p>
      )}
    </div>
  );
}

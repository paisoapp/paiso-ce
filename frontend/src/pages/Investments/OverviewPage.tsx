import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronUp, GripVertical, RotateCcw } from "@/lib/icons";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { AccountLogo, typeStyle } from "@/components/accounts/AccountList";
import {
  useAccountValueHistory,
  useInvestmentsAllocation,
  useInvestmentsOverview,
  type OverviewCard,
} from "@/hooks/useInvestmentsOverview";
import { useDailySectionRange } from "@/hooks/useSectionDateRange";
import { DailyRangeHint } from "@/components/ui/RangeEmptyHint";
import { cn, formatCurrency } from "@/lib/utils";
import { AssetClassDonut, useClassColors } from "./AssetMix";
import { InvestmentsPerformanceChart, useInvestmentsTypeSeries } from "./InvestmentsPerformanceChart";

/**
 * Investments → Overview, in the layout of Budgeting's Cash Flow and
 * Transactions' All tab: a header with the date range and account filter,
 * headline stat cards, two chart cards side by side, then a table.
 *
 * Every figure comes from the investment book the Dashboard reads, so the
 * total here is the Dashboard's.
 */

/** Investment type → its tab. */
const TAB_FOR: Record<string, string> = {
  investing: "stocks", retirement: "retirement", education: "education", health: "health",
};
const TAX_ORDER = ["tax_deferred", "tax_free", "taxable", "not_set"];

function Stat({ label, value, className, sub }: { label: string; value: string; className?: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold tabular-nums", className)}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/** One purpose section (Retirement, Education, …): dragged by its grip,
 *  collapsed by its header, as on the Portfolio page. */
function SortableGroup({ id, children }: { id: string; children: (handle: ReactNode) => ReactNode }) {
  const {
    attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
  } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      {...attributes}
      {...listeners}
      className="touch-none cursor-grab active:cursor-grabbing self-stretch flex items-center pl-3 pr-1 text-muted-foreground/60 hover:text-foreground"
      aria-label="Drag to reorder this section"
      title="Drag to reorder"
    >
      <GripVertical size={16} />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-20 opacity-90 shadow-lg rounded-xl")}
    >
      {children(handle)}
    </div>
  );
}

/** The saved order with unknown ids dropped and new ones appended in the
 *  server's order. */
function resolveGroupOrder(saved: string[] | null, ids: string[]): string[] {
  const kept = (saved ?? []).filter((id, i, all) => ids.includes(id) && all.indexOf(id) === i);
  return [...kept, ...ids.filter((id) => !kept.includes(id))];
}

/** The same column widths in every section, so the cards line up. */
const ACCOUNT_COLS = (
  <colgroup>
    <col />
    <col className="w-[18%]" />
    <col className="w-[14%]" />
    <col className="w-[14%]" />
    <col className="w-[12%]" />
  </colgroup>
);

export function OverviewPage() {
  const navigate = useNavigate();
  // Overview's own range. Its values are daily, so a pick under a
  // week selects the last 30 days instead, with a hint.
  const { dateRange, setDateRange, replaced } = useDailySectionRange("investments_overview");
  const [accountId, setAccountId] = useState<number | undefined>(undefined);

  const { data, isLoading } = useInvestmentsOverview();

  // ── Section order and collapsed state, saved per account (ui_prefs) ──────
  const savedOrder = useUiPrefsStore((st) => st.investmentsSectionOrder);
  const setSavedOrder = useUiPrefsStore((st) => st.setInvestmentsSectionOrder);
  const collapsed = useUiPrefsStore((st) => st.investmentsCollapsed);
  const setCollapsed = useUiPrefsStore((st) => st.setInvestmentsCollapsed);
  const groupIds = useMemo(() => (data?.groups ?? []).map((g) => g.purpose), [data]);
  const groupOrder = useMemo(() => resolveGroupOrder(savedOrder, groupIds), [savedOrder, groupIds]);
  const orderCustomized = savedOrder !== null && groupOrder.join() !== groupIds.join();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  function onGroupDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = groupOrder.indexOf(String(active.id));
    const to = groupOrder.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setSavedOrder(arrayMove(groupOrder, from, to));
  }
  const toggleGroup = (id: string) =>
    setCollapsed(collapsed.includes(id) ? collapsed.filter((c) => c !== id) : [...collapsed, id]);
  const { data: alloc } = useInvestmentsAllocation(true, accountId);
  const { data: history } = useAccountValueHistory(dateRange);
  /** An account's change in value over the range, from its own history. */
  const changeOf = (c: OverviewCard): number | null => {
    const pts = c.id != null ? history?.series[String(c.id)] : undefined;
    return pts && pts.length > 1 ? pts[pts.length - 1].balance - pts[0].balance : null;
  };
  const classColors = useClassColors(alloc?.asset_classes ?? []);

  const cards = useMemo(
    () => (data?.groups ?? []).flatMap((g) => g.accounts.map((c) => ({ ...c, purpose: c.purpose ?? g.purpose }))),
    [data],
  );
  const shown = accountId ? cards.filter((c) => c.kind === "account" && c.id === accountId) : cards;
  const accountOptions = cards
    .filter((c) => c.kind === "account" && c.id != null)
    .map((c) => ({ id: c.id!, name: c.name }));

  // ── Headline figures for what is shown ───────────────────────────────────
  // Excluded from net worth changes nothing here: those accounts are dimmed,
  // and counted like any other. The part net worth leaves out is
  // named under the total, so the gap to the Dashboard is explained.
  const total = shown.reduce((s, c) => s + c.value, 0);
  const excludedTotal = shown.reduce((s, c) => s + (c.excluded_value ?? 0), 0);
  const byTax: Record<string, number> = {};
  for (const c of shown) {
    const t = c.tax_treatment ?? "not_set";
    byTax[t] = (byTax[t] ?? 0) + c.value;
  }

  // ── Change over the range, from each account's own series ──────────────
  const { change } = useInvestmentsTypeSeries(dateRange, accountId, "total");


  const openCard = (c: OverviewCard) => {
    navigate(`/investments/${TAB_FOR[c.purpose ?? "investing"] ?? "stocks"}?account=${c.id}`);
  };
  const firstStale = shown.find((c) => c.stale);
  const staleCount = shown.filter((c) => c.stale).length;

  if (isLoading || !data) return <div className="h-40 rounded-xl bg-muted animate-pulse" />;

  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-6 py-10 text-center text-sm text-muted-foreground">
        No investment accounts yet. Add a brokerage, retirement, 529 or HSA account to see it here.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Overview</h2>
          <p className="text-sm text-muted-foreground">
            Total: <span className="font-medium text-foreground">{formatCurrency(total)}</span>
            {excludedTotal >= 0.005 && (
              <span> · {formatCurrency(excludedTotal)} of it is excluded from net worth</span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />
          {accountOptions.length > 1 && (
            <AccountFilterSelect value={accountId} onChange={setAccountId} accounts={accountOptions} />
          )}
        </div>
      </div>

      <DailyRangeHint replaced={replaced} what="Account values" className="-mt-3" />

      {/* ── Summary cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <Stat label="Total investments" value={formatCurrency(total)} />
        <Stat
          label="Change in period"
          value={change == null ? "—" : `${change >= 0 ? "+" : ""}${formatCurrency(change)}`}
          className={change == null ? "" : change >= 0 ? "text-success" : "text-destructive"}
        />
        {TAX_ORDER.filter((t) => t !== "not_set").map((t) => (
          <Stat key={t} label={data.tax_labels[t] ?? t} value={formatCurrency(byTax[t] ?? 0)}
            sub={total > 0 ? `${(((byTax[t] ?? 0) / total) * 100).toFixed(0)}% of total` : undefined} />
        ))}
      </div>

      {staleCount > 0 && firstStale && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600" />
            {staleCount === 1
              ? `A value you entered is over ${data.manual_price_stale_days} days old.`
              : `${staleCount} values you entered are over ${data.manual_price_stale_days} days old.`}
          </span>
          <Button size="sm" variant="outline" onClick={() => openCard(firstStale)}>Update</Button>
        </div>
      )}

      {/* ── Charts ─────────────────────────────────────────────────────── */}
      <div className={cn("grid grid-cols-1 gap-6", alloc && "lg:grid-cols-2")}>
        {alloc && (
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">What it is invested in</h3>
            <AssetClassDonut slices={alloc.by_asset_class} total={alloc.total} colors={classColors} />
          </div>
        )}
        <div className="rounded-xl border border-border bg-card p-4">
          <InvestmentsPerformanceChart dateRange={dateRange} accountId={accountId} title="Performance" />
        </div>
      </div>

      {/* ── Accounts, one card per purpose: drag to reorder, click to collapse ── */}
      <div className="space-y-3">
        {orderCustomized && (
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => setSavedOrder(null)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              title="Put the sections back in their default order"
            >
              <RotateCcw size={12} /> Reset order
            </button>
          </div>
        )}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onGroupDragEnd}>
          <SortableContext items={groupOrder} strategy={verticalListSortingStrategy}>
            {groupOrder.map((gid) => {
              const g = data.groups.find((x) => x.purpose === gid);
              if (!g) return null;
              const rows = g.accounts.filter((c) => !accountId || (c.kind === "account" && c.id === accountId));
              if (!rows.length) return null;
              const groupTotal = rows.reduce((s, c) => s + c.value, 0);
              const open = !collapsed.includes(gid);
              return (
                <SortableGroup key={gid} id={gid}>
                  {(handle) => (
                    <div className="rounded-xl border border-border bg-card overflow-hidden">
                      <div className="flex items-center bg-muted/40 hover:bg-muted/60 transition-colors">
                        {handle}
                        <button
                          type="button"
                          className="flex-1 min-w-0 flex items-center gap-3 py-2.5 pl-1 pr-3 text-left"
                          onClick={() => toggleGroup(gid)}
                          aria-expanded={open}
                        >
                          <span className="font-semibold text-sm">{g.label}</span>
                          <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{rows.length}</span>
                          <span className="ml-auto font-semibold tabular-nums text-sm">{formatCurrency(groupTotal)}</span>
                          {open
                            ? <ChevronUp size={14} className="text-muted-foreground shrink-0" />
                            : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
                        </button>
                      </div>
                      {/* Phones get a stacked row per account instead of the
                          five-column table, which only fit by scrolling
                          sideways. */}
                      {open && (
                        <ul className="md:hidden divide-y divide-border border-t border-border">
                          {rows.map((c) => {
                            const delta = changeOf(c);
                            const detail = [c.subtype_label, c.tax_treatment_label].filter(Boolean).join(" · ");
                            return (
                              <li key={`${c.kind}-${c.id ?? c.name}`}>
                                <button type="button" onClick={() => openCard(c)}
                                  title={c.excluded ? "Excluded from net worth" : undefined}
                                  className={cn("w-full flex items-center gap-2.5 px-3 py-2.5 text-left text-sm active:bg-accent transition-colors",
                                    c.excluded && "opacity-60")}>
                                  <AccountLogo size="sm" accent={typeStyle(c.account_type)} />
                                  <div className="min-w-0 flex-1">
                                    <p className="font-medium truncate">{c.name}</p>
                                    {(c.institution || detail) && (
                                      <p className="text-xs text-muted-foreground/80 truncate">
                                        {[c.institution, detail].filter(Boolean).join(" · ")}
                                      </p>
                                    )}
                                  </div>
                                  <div className="shrink-0 text-right tabular-nums">
                                    <p className="font-medium">{formatCurrency(c.value)}</p>
                                    <p className={cn("text-xs",
                                      delta == null ? "text-muted-foreground" : delta >= 0 ? "text-success" : "text-destructive")}>
                                      {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${formatCurrency(delta)}`}
                                    </p>
                                  </div>
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      {open && (
                        <div className="hidden md:block overflow-x-auto">
                          <table className="w-full text-sm table-fixed min-w-[640px]">
                            {ACCOUNT_COLS}
                            <thead className="border-y border-border">
                              <tr>
                                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Account</th>
                                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Kind</th>
                                <th className="px-3 py-2 text-left font-medium text-muted-foreground">Tax</th>
                                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Value</th>
                                <th className="px-3 py-2 text-right font-medium text-muted-foreground">Change</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.map((c) => {
                                const delta = changeOf(c);
                                return (
                                  <tr key={`${c.kind}-${c.id ?? c.name}`}
                                    onClick={() => openCard(c)}
                                    title={c.excluded ? "Excluded from net worth" : undefined}
                                    className={cn("border-b border-border last:border-0 cursor-pointer hover:bg-muted/30 transition-colors",
                                      c.excluded && "opacity-60")}>
                                    <td className="px-3 py-2.5">
                                      <div className="flex items-center gap-2.5 min-w-0">
                                        <AccountLogo size="sm" accent={typeStyle(c.account_type)} />
                                        <div className="min-w-0">
                                          <p className="font-medium truncate">{c.name}</p>
                                          {c.institution && <p className="text-xs text-muted-foreground/80 truncate">{c.institution}</p>}
                                        </div>
                                      </div>
                                    </td>
                                    <td className="px-3 py-2.5 text-muted-foreground truncate">{c.subtype_label ?? "—"}</td>
                                    <td className="px-3 py-2.5 text-muted-foreground truncate">{c.tax_treatment_label ?? "—"}</td>
                                    <td className="px-3 py-2.5 text-right tabular-nums font-medium">{formatCurrency(c.value)}</td>
                                    <td className={cn("px-3 py-2.5 text-right tabular-nums",
                                      delta == null ? "text-muted-foreground" : delta >= 0 ? "text-success" : "text-destructive")}>
                                      {delta == null ? "—" : `${delta >= 0 ? "+" : ""}${formatCurrency(delta)}`}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </SortableGroup>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

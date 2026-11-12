import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type DragOverEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { ChevronLeft, ChevronRight, Settings } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import {
  useBudgetProgress,
  useSaveDraft,
  type Bucket,
  type BudgetPlan,
  type ProgressLine,
} from "@/hooks/useBudgetPlan";
import { MonthStrip } from "./MonthStrip";
import { BudgetSwitcher } from "./BudgetSwitcher";
import { BucketCard } from "./BucketCard";
import { CategoryDrawer } from "./CategoryDrawer";
import { BUCKETS, barColor } from "./bucketMeta";
import { SpendingPaceChart, useSpendingPace } from "@/components/cashflow/SpendingPaceChart";
import { DraftContext, applyDraft, wholeDiff, type DraftApi, type DraftStep } from "./budgetDraft";
import { DraftBar, useLeaveGuard } from "./DraftBar";

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${String(Math.floor(idx / 12)).padStart(4, "0")}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

function monthLabel(month: string): string {
  return new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type Order = Record<Bucket, number[]>;

function groupLines(lines: ProgressLine[] | undefined): Order {
  const out: Order = { needs: [], wants: [], savings: [] };
  for (const l of lines ?? []) out[l.bucket].push(l.category_id);
  return out;
}

/** Spending against the clock: within five points of the month's elapsed share is on pace. */
function paceLabel(spentShare: number, elapsedShare: number): { text: string; className: string } {
  const diff = spentShare - elapsedShare;
  if (Math.abs(diff) <= 0.05) return { text: "On pace", className: "text-muted-foreground" };
  return diff > 0
    ? { text: "Over pace", className: "text-warning" }
    : { text: "Under pace", className: "text-success" };
}

function StatCard({ label, value, note, valueClass = "", onClick, action }: {
  label: string; value: string; note?: string; valueClass?: string;
  /** Makes the card a button, as cards that open a drawer are elsewhere. */
  onClick?: () => void;
  /** What the click opens, as a link line under the note. */
  action?: string;
}) {
  const body = (
    <>
      <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        {label}
        {/* Only a card that opens something has the chevron, so it always means that. */}
        {onClick && <ChevronRight size={14} className="shrink-0" aria-hidden />}
      </p>
      <p className={`text-lg font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {note && <p className="text-xs text-muted-foreground mt-0.5">{note}</p>}
      {onClick && action && <p className="mt-1 text-xs font-medium text-primary group-hover:underline">{action}</p>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick}
      className="group rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/30 hover:border-primary/40">
      {body}
    </button>
  ) : (
    <div className="rounded-xl border border-border bg-card px-4 py-3">{body}</div>
  );
}

export function BudgetDashboard({
  plan,
  month,
  onMonthChange,
  onEdit,
  onNew,
}: {
  plan: BudgetPlan;
  month: string;
  onMonthChange: (m: string) => void;
  onEdit: () => void;
  onNew: () => void;
}) {
  const { data: saved, isLoading } = useBudgetProgress(month);
  // Changes wait here until Save. `redo` holds undone steps.
  const [steps, setSteps] = useState<DraftStep[]>([]);
  const [redo, setRedo] = useState<DraftStep[]>([]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveDraft = useSaveDraft();
  const data = useMemo(() => (saved ? applyDraft(saved, steps) : saved), [saved, steps]);
  const discard = useCallback(() => { setSteps([]); setRedo([]); setSaveError(null); }, []);
  const undo = useCallback(() => {
    setSteps((s) => {
      if (s.length === 0) return s;
      setRedo((r) => [...r, s[s.length - 1]]);
      return s.slice(0, -1);
    });
  }, []);
  const redoStep = useCallback(() => {
    setRedo((r) => {
      if (r.length === 0) return r;
      setSteps((s) => [...s, r[r.length - 1]]);
      return r.slice(0, -1);
    });
  }, []);
  const draftApi = useMemo<DraftApi>(() => ({
    stage: (step) => { setSteps((s) => [...s, step]); setRedo([]); setSaveError(null); },
    pending: steps.length,
  }), [steps.length]);
  const save = () => {
    setSaveError(null);
    saveDraft.mutate(steps, {
      onSuccess: () => discard(),
      onError: (err) => {
        // Steps already sent are saved; keep the rest staged to try again.
        const done = (err as { done?: number }).done ?? 0;
        setSteps((s) => s.slice(done));
        setSaveError(`${done ? `${done} saved; ` : ""}the rest did not save. Try again.`);
      },
    });
  };
  const leave = useLeaveGuard(steps.length > 0, discard);
  const { data: spendingPace } = useSpendingPace();
  // The category open in the side drawer, by id, so it follows fresh data.
  const [openId, setOpenId] = useState<number | null>(null);
  const [order, setOrder] = useState<Order>(() => groupLines(data?.lines));
  useEffect(() => setOrder(groupLines(data?.lines)), [data]);
  const byId = useMemo(() => new Map((data?.lines ?? []).map((l) => [l.category_id, l])), [data]);
  // Past months keep the amounts they had, so only this month and
  // later can be changed.
  const editable = month >= thisMonth();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const bucketOf = (id: string | number, o: Order): Bucket | null => {
    if (typeof id === "string" && id.startsWith("bucket:")) return id.slice(7) as Bucket;
    return BUCKETS.find((b) => o[b].includes(Number(id))) ?? null;
  };

  // Moving between buckets happens as the row is dragged over the other one.
  function onDragOver({ active, over }: DragOverEvent) {
    if (!over) return;
    setOrder((o) => {
      const from = bucketOf(active.id, o);
      const to = bucketOf(over.id, o);
      if (!from || !to || from === to) return o;
      const id = Number(active.id);
      const target = o[to].indexOf(Number(over.id));
      const next = { ...o, [from]: o[from].filter((x) => x !== id), [to]: [...o[to]] };
      next[to].splice(target < 0 ? next[to].length : target, 0, id);
      return next;
    });
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    const b = bucketOf(active.id, order);
    if (!b) return;
    let next = order;
    const from = order[b].indexOf(Number(active.id));
    const to = order[b].indexOf(Number(over.id));
    if (from >= 0 && to >= 0 && from !== to) next = { ...order, [b]: arrayMove(order[b], from, to) };
    setOrder(next);
    const changed = BUCKETS.some((bk) =>
      next[bk].some((id, i) => byId.get(id)?.bucket !== bk || byId.get(id)?.position !== i),
    );
    if (changed) {
      const name = byId.get(Number(active.id))?.name ?? "Category";
      draftApi.stage({
        kind: "order",
        order: BUCKETS.flatMap((bk) => next[bk].map((id, i) => ({ category_id: id, bucket: bk, position: i }))),
        label: `Move ${name}`,
      });
    }
  }

  if (isLoading || !data) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const showPace = data.is_current && !!spendingPace && (spendingPace.total > 0 || spendingPace.previous_total > 0);
  const spentShare = data.total_budget > 0 ? data.total_spent / data.total_budget : 0;
  const pacePct = data.month_pct_elapsed * 100;
  const pace = data.is_current ? paceLabel(spentShare, data.month_pct_elapsed) : null;
  const leftToAssign = wholeDiff(data.total_budget, data.allocated);
  const perDay = data.is_current ? Math.max(0, data.safe_to_spend) / (data.days_remaining + 1) : null;
  // Whole dollars, as shown, so a few cents either way reads $0 and not -$0.
  const rolloverIn = Math.round(data.lines.reduce((s, l) => s + (l.rollover_enabled ? l.carryover : 0), 0)) || 0;

  return (
    <div className="space-y-5">
      {/* ── Header: month nav + edit ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => leave.ask(() => onMonthChange(shiftMonth(month, -1)))} aria-label="Previous month" className="p-1.5 rounded-md hover:bg-muted">
            <ChevronLeft size={18} />
          </button>
          <span className="text-base font-semibold w-40 text-center">{monthLabel(month)}</span>
          <button
            onClick={() => leave.ask(() => onMonthChange(shiftMonth(month, 1)))}
            disabled={data.is_current}
            aria-label="Next month"
            className="p-1.5 rounded-md hover:bg-muted disabled:opacity-30"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <BudgetSwitcher plan={plan} onNew={() => leave.ask(onNew)} guard={leave.ask} />
          <button
            onClick={() => leave.ask(onEdit)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted"
          >
            <Settings size={14} /> Budget settings
          </button>
        </div>
      </div>

      {/* ── 12-month report card ───────────────────────────────────────────── */}
      <MonthStrip selectedMonth={month} onSelect={(m) => leave.ask(() => onMonthChange(m))} />

      {/* ── Safe to spend and the summary cards, with this
          month's spending beside them. The bucket cards that sat below are
          now each bucket's heading, and the chart takes their
          room. It covers this month only, so a past month keeps one column. */}
      <div className={`grid grid-cols-1 gap-4 ${showPace ? "lg:grid-cols-2" : ""}`}>
      <div className="space-y-3">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Safe to spend</p>
            <p className={`text-3xl font-bold tabular-nums ${data.safe_to_spend < 0 ? "text-destructive" : "text-foreground"}`}>
              {formatCurrency(data.safe_to_spend)}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {formatCurrency(data.total_spent)} spent of {formatCurrency(data.total_budget)}
              {data.is_current && ` · ${data.days_remaining} days left`}
            </p>
            {data.before_start && (
              <p className="text-xs text-muted-foreground mt-1">
                This month is before your budget started, so it is not graded. The numbers are for comparison.
              </p>
            )}
          </div>
          {pace && (
            <p className={`text-sm font-medium ${pace.className}`} title="Your spending so far against how much of the month has passed">
              {pace.text}
            </p>
          )}
        </div>
        <div className="relative h-3 w-full rounded-full bg-muted overflow-hidden mt-4">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${Math.min(100, spentShare * 100)}%`, background: barColor(data.total_spent, data.total_budget) }}
          />
          {data.is_current && (
            <div className="absolute top-0 h-full w-0.5 bg-foreground/60" style={{ left: `${pacePct}%` }} title="Today's pace" />
          )}
        </div>
        {data.unbudgeted_spend > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            + {formatCurrency(data.unbudgeted_spend)} spent in categories without a budget line.
          </p>
        )}
      </div>
      <div className={`grid grid-cols-2 gap-3 ${showPace ? "" : "lg:grid-cols-4"}`}>
        <StatCard
          label="Left to assign"
          value={formatCurrency(leftToAssign)}
          note={leftToAssign === 0 ? "Every dollar has a job." : `of ${formatCurrency(data.total_budget)}, the goal is $0`}
          valueClass={leftToAssign < 0 ? "text-destructive" : leftToAssign > 0 ? "text-warning" : "text-success"}
        />
        {perDay !== null && (
          <StatCard label="Per day left" value={formatCurrency(perDay)} note={`for ${data.days_remaining + 1} days, today included`} />
        )}
        <StatCard
          label="Rollover"
          value={`${rolloverIn > 0 ? "+" : ""}${formatCurrency(rolloverIn)}`}
          note="carried in from earlier months"
          valueClass={rolloverIn < 0 ? "text-destructive" : ""}
        />
      </div>
      </div>
      {showPace && spendingPace && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="mb-2 text-sm font-medium text-muted-foreground">Spending This Month</h3>
          <SpendingPaceChart data={spendingPace} budget={data.total_budget} height={220} />
        </div>
      )}
      </div>

      {/* ── One table per bucket ──────────────────────────── */}
      <DraftContext.Provider value={editable ? draftApi : { stage: () => {}, pending: 0 }}>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragOver={onDragOver} onDragEnd={onDragEnd}>
        <div className="space-y-4">
          {BUCKETS.map((b) => (
            <BucketCard
              key={b}
              bucket={b}
              lines={order[b].map((id) => byId.get(id)).filter((l): l is ProgressLine => !!l)}
              rollup={data.buckets[b]}
              addable={data.addable}
              month={month}
              editable={editable}
              pacePct={data.is_current ? pacePct : 0}
              onOpen={(l) => setOpenId(l.category_id)}
            />
          ))}
        </div>
      </DndContext>
      </DraftContext.Provider>
      <CategoryDrawer line={openId != null ? byId.get(openId) ?? null : null} month={month} onClose={() => setOpenId(null)} />
      <DraftBar
        steps={steps}
        canRedo={redo.length > 0}
        saving={saveDraft.isPending}
        error={saveError}
        onUndo={undo}
        onRedo={redoStep}
        onDiscard={discard}
        onSave={save}
      />
      {leave.dialog}
    </div>
  );
}

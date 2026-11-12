import { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, GripVertical, MoreHorizontal, Plus, RotateCw } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { CategoryIcon } from "@/lib/categoryIcons";
import type { AddableCategory, Bucket, BucketRollup, LineEdit, ProgressLine } from "@/hooks/useBudgetPlan";
import { AllocatedCell, RemainingCell, UsedCell } from "./CellPopovers";
import { BUCKETS, BUCKET_META, barColor } from "./bucketMeta";
import { Popover } from "./Popover";
import { useDraft, usedShare, wholeDiff } from "./budgetDraft";

/** Columns of a row on a computer: grip, category, the three figures, menu. */
const GRID = "md:grid md:grid-cols-[1.25rem_minmax(0,1fr)_7.5rem_7.5rem_7.5rem_2rem] md:items-center md:gap-2";

/**
 * One bucket of the Budget tab: a row per category
 * with Allocated, Used and Remaining, a bar under each, and the rows dragged
 * to reorder them or to move them to another bucket.
 */
export function BucketCard({
  bucket,
  lines,
  rollup,
  addable,
  month,
  editable,
  pacePct,
  onOpen,
}: {
  bucket: Bucket;
  lines: ProgressLine[];
  rollup: BucketRollup;
  addable: AddableCategory[];
  month: string;
  editable: boolean;
  pacePct: number;
  /** Opens the category's side drawer. */
  onOpen: (line: ProgressLine) => void;
}) {
  const meta = BUCKET_META[bucket];
  const [collapsed, setCollapsed] = useState(false);
  // What the bucket's own card showed above the tables, now in its heading.
  const usedPct = rollup.available > 0 ? rollup.actual / rollup.available : 0;
  const remaining = wholeDiff(rollup.available, rollup.actual);
  const { setNodeRef, isOver } = useDroppable({ id: `bucket:${bucket}` });

  return (
    <section className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="w-full flex flex-wrap items-start gap-x-3 gap-y-1 rounded-t-xl px-4 py-3 bg-muted/50 border-b border-border hover:bg-muted transition-colors text-left"
      >
        <ChevronDown size={16} className={`mt-0.5 text-muted-foreground transition-transform ${collapsed ? "-rotate-90" : ""}`} />
        <span className="flex-1 min-w-[12rem]">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
            <span className="text-sm font-semibold">{meta.label}</span>
          </span>
          <span className="block text-xs text-muted-foreground mt-0.5">{meta.hint}</span>
        </span>
        {rollup.available > 0 && (
          <span className="text-sm font-semibold tabular-nums" style={{ color: barColor(rollup.actual, rollup.available) }}>
            {Math.round(usedPct * 100)}%
          </span>
        )}
        <span className="basis-full pl-7">
          <span className="relative block h-1.5 w-full rounded-full bg-muted overflow-hidden" aria-hidden>
            <span className="block h-full rounded-full transition-all"
              style={{ width: `${Math.min(100, usedPct * 100)}%`, background: barColor(rollup.actual, rollup.available) }} />
            {pacePct > 0 && pacePct < 100 && (
              <span className="absolute top-0 h-full w-0.5 bg-foreground/50" style={{ left: `${pacePct}%` }} />
            )}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
            {formatCurrency(rollup.budgeted)} allocated · {formatCurrency(rollup.actual)} used ·{" "}
            <span className={remaining < 0 ? "text-destructive" : ""}>{formatCurrency(remaining)} remaining</span>
          </span>
        </span>
      </button>

      {!collapsed && (
        <>
          <div className={`hidden ${GRID} px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground`}>
            <span />
            <span>Category</span>
            <span className="text-right">Allocated</span>
            <span className="text-right">Used</span>
            <span className="text-right">Remaining</span>
            <span />
          </div>
          <SortableContext items={lines.map((l) => l.category_id)} strategy={verticalListSortingStrategy}>
            <div ref={setNodeRef} className={`divide-y divide-border min-h-[2.5rem] ${isOver ? "bg-primary/5" : ""}`}>
              {lines.map((l) => (
                <Row key={l.category_id} line={l} month={month} editable={editable} pacePct={pacePct} onOpen={onOpen} />
              ))}
              {lines.length === 0 && (
                <p className="px-4 py-3 text-xs text-muted-foreground">
                  {editable ? "Drag a category here, or add one below." : "Nothing in this bucket this month."}
                </p>
              )}
            </div>
          </SortableContext>
          {editable && <AddCategory bucket={bucket} addable={addable} month={month} />}
        </>
      )}
    </section>
  );
}

function Row({ line, month, editable, pacePct, onOpen }: {
  line: ProgressLine; month: string; editable: boolean; pacePct: number; onOpen: (line: ProgressLine) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: line.category_id,
    disabled: !editable,
  });
  const pct = Math.max(0, usedShare(line));
  const color = barColor(line.actual, line.available);
  const remaining = <RemainingCell line={line} />;
  const name = (
    <span className="flex items-center gap-2 min-w-0">
      <CategoryIcon name={line.name} icon={line.icon} size={14} className="shrink-0" />
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onOpen(line); }}
        title={`Open ${line.name}`}
        className="text-sm font-medium truncate text-left"
      >
        {line.name}
      </button>
      {line.rollover_enabled && (
        <span title={`Rollover on: ${line.carryover >= 0 ? "+" : ""}${formatCurrency(line.carryover)} carried in`}>
          <RotateCw size={12} className="text-primary shrink-0" />
        </span>
      )}
    </span>
  );
  const grip = editable ? (
    <button
      type="button"
      {...attributes}
      {...listeners}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Drag ${line.name} to reorder or move it`}
      className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
    >
      <GripVertical size={14} />
    </button>
  ) : <span />;

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      // The whole row opens the category's drawer, as rows do elsewhere in
      // the app; the figures, grip and menu inside keep their own clicks.
      onClick={() => onOpen(line)}
      className={`px-4 py-2.5 bg-card cursor-pointer hover:bg-muted/30 transition-colors ${isDragging ? "relative z-10 shadow-lg opacity-90" : ""}`}
    >
      {/* Computer: one row of columns. */}
      <div className={`hidden ${GRID}`}>
        {grip}
        {name}
        <span className="text-right"><AllocatedCell line={line} month={month} editable={editable} /></span>
        <span className="text-right"><UsedCell line={line} month={month} /></span>
        <span className="text-right">{remaining}</span>
        {editable ? <RowMenu line={line} month={month} /> : <span />}
      </div>
      {/* Phone: name and Remaining, the bar, then Allocated and Used. */}
      <div className="md:hidden">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 min-w-0">{grip}{name}</span>
          <span className="flex items-center gap-1">{remaining}{editable && <RowMenu line={line} month={month} />}</span>
        </div>
      </div>
      <Bar pct={pct} color={color} pacePct={pacePct} />
      <div className="md:hidden mt-1 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">Allocated <AllocatedCell line={line} month={month} editable={editable} /></span>
        <span className="flex items-center gap-1">Used <UsedCell line={line} month={month} /></span>
      </div>
    </div>
  );
}

function Bar({ pct, color, pacePct }: { pct: number; color: string; pacePct: number }) {
  return (
    <div className="relative mt-1.5 h-1 w-full rounded-full bg-muted overflow-hidden md:ml-[1.75rem] md:w-[calc(100%-1.75rem)]">
      <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, pct * 100)}%`, background: color }} />
      {pacePct > 0 && pacePct < 100 && (
        <div className="absolute top-0 h-full w-0.5 bg-foreground/50" style={{ left: `${pacePct}%` }} title="Expected pace for today" />
      )}
    </div>
  );
}

function RowMenu({ line, month }: { line: ProgressLine; month: string }) {
  const [open, setOpen] = useState(false);
  const { stage } = useDraft();
  const act = (edit: LineEdit, label: string) => {
    stage({ kind: "line", categoryId: line.category_id, edit: { ...edit, month }, label });
    setOpen(false);
  };
  const item = "w-full text-left px-2 py-1.5 rounded-md hover:bg-muted text-sm";
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={line.name}
      width="md:w-56"
      trigger={
        <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`More for ${line.name}`}
          className="p-1 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
          <MoreHorizontal size={16} />
        </button>
      }
    >
      <div className="flex flex-col">
        {BUCKETS.filter((b) => b !== line.bucket).map((b) => (
          <button key={b} type="button" className={item}
            onClick={() => act({ bucket: b }, `Move ${line.name} to ${BUCKET_META[b].label}`)}>
            Move to {BUCKET_META[b].label}
          </button>
        ))}
        <button type="button" className={item}
          onClick={() => act({ rollover_enabled: !line.rollover_enabled },
            `Turn rollover ${line.rollover_enabled ? "off" : "on"} for ${line.name}`)}>
          {line.rollover_enabled ? "Turn rollover off" : "Turn rollover on"}
        </button>
        <button type="button" className={`${item} text-destructive`}
          onClick={() => act({ hidden: true }, `Remove ${line.name}`)}>
          Remove from budget
        </button>
      </div>
    </Popover>
  );
}

/** Brings back a removed category, or adds one that has never had a line. */
function AddCategory({ bucket, addable, month }: { bucket: Bucket; addable: AddableCategory[]; month: string }) {
  const [open, setOpen] = useState(false);
  const { stage } = useDraft();
  if (addable.length === 0) return null;
  const add = (a: AddableCategory) => {
    stage({
      kind: "line",
      categoryId: a.category_id,
      edit: a.hidden ? { hidden: false, bucket, month } : { amount: 0, bucket, month },
      label: `Add ${a.name}`,
    });
    setOpen(false);
  };
  return (
    <div className="border-t border-border px-4 py-2">
      <Popover
        open={open}
        onOpenChange={setOpen}
        align="left"
        width="md:w-72"
        label={`Add a category to ${BUCKET_META[bucket].label}`}
        trigger={
          <button type="button" onClick={() => setOpen((o) => !o)}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus size={12} /> Add a category
          </button>
        }
      >
        <ul className="max-h-72 overflow-y-auto">
          {addable.map((a) => (
            <li key={a.category_id}>
              <button type="button" onClick={() => add(a)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-muted text-sm text-left">
                <span className="flex items-center gap-2 min-w-0">
                  <CategoryIcon name={a.name} icon={a.icon} size={13} className="shrink-0" />
                  <span className="truncate">{a.name}</span>
                </span>
                {a.hidden && (
                  <span className="text-[11px] text-muted-foreground shrink-0">
                    Removed{a.last_amount > 0 ? ` · ${formatCurrency(a.last_amount)}` : ""}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}

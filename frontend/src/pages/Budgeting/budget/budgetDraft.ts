import { createContext, useContext } from "react";
import type { AddableCategory, Bucket, BudgetProgress, LineEdit, ProgressLine } from "@/hooks/useBudgetPlan";
import { BUCKETS } from "./bucketMeta";

/**
 * Changes on the Budget tab wait until Save. Each change is a
 * staged step: one line's edit (amount, bucket, rollover, removed or added),
 * or the order after a drag. Undo and Redo walk the steps; Save sends them in
 * order, as the edits they always were; Discard drops them. Until then the tab
 * shows the month as it will be, worked out here from the server's figures.
 */
export type DraftStep =
  | { kind: "line"; categoryId: number; edit: LineEdit; label: string }
  | { kind: "order"; order: { category_id: number; bucket: Bucket; position: number }[]; label: string };

export interface DraftApi {
  /** Stage a change. Past months cannot be changed, so this is a no-op there. */
  stage: (step: DraftStep) => void;
  /** Steps staged and not yet saved. */
  pending: number;
}

export const DraftContext = createContext<DraftApi>({ stage: () => {}, pending: 0 });

export function useDraft(): DraftApi {
  return useContext(DraftContext);
}

/** Whole dollars, as the tab shows them, so the figures shown add up:
 *  $79 allocated and $79 used leave $0, never "$1" or "-$0". */
export function wholeDiff(a: number, b: number): number {
  return Math.round(a) - Math.round(b) || 0;
}

/** How much of what is available a line has used, for its bar. Spending with
 *  nothing available is over, not "near". */
export function usedShare(line: Pick<ProgressLine, "available" | "actual">): number {
  if (line.available > 0) return line.actual / line.available;
  return line.actual > 0 ? 2 : 0;
}

function withFigures(line: ProgressLine): ProgressLine {
  const carryover = line.rollover_enabled ? line.carryover : 0;
  const available = Math.round((line.budgeted + carryover) * 100) / 100;
  const remaining = Math.round((available - line.actual) * 100) / 100;
  return { ...line, carryover, available, remaining, pct: usedShare({ available, actual: line.actual }) };
}

function lastPosition(lines: ProgressLine[], bucket: Bucket): number {
  return lines.filter((l) => l.bucket === bucket).reduce((m, l) => Math.max(m, l.position), -1) + 1;
}

/** The month as it will be once `steps` are saved. */
export function applyDraft(base: BudgetProgress, steps: DraftStep[]): BudgetProgress {
  if (steps.length === 0) return base;
  let lines = base.lines.map((l) => ({ ...l }));
  let addable: AddableCategory[] = base.addable.map((a) => ({ ...a }));

  for (const step of steps) {
    if (step.kind === "order") {
      const at = new Map(step.order.map((o) => [o.category_id, o]));
      lines = lines.map((l) => {
        const o = at.get(l.category_id);
        return o ? { ...l, bucket: o.bucket, position: o.position } : l;
      });
      continue;
    }
    const { categoryId, edit } = step;
    let line = lines.find((l) => l.category_id === categoryId);
    if (edit.hidden) {
      if (!line) continue;
      lines = lines.filter((l) => l.category_id !== categoryId);
      addable = [
        {
          category_id: line.category_id, name: line.name, icon: line.icon, hidden: true,
          last_amount: line.budgeted > 0 ? line.budgeted : 0, bucket: line.bucket, actual: line.actual,
        },
        ...addable.filter((a) => a.category_id !== categoryId),
      ];
      continue;
    }
    if (!line) {
      const a = addable.find((x) => x.category_id === categoryId);
      if (!a) continue;
      const bucket = edit.bucket ?? a.bucket;
      line = {
        category_id: a.category_id, name: a.name, color: null, icon: a.icon, bucket,
        position: lastPosition(lines, bucket), rollover_enabled: false, one_month: false,
        budgeted: edit.amount ?? (a.hidden ? a.last_amount : 0), carryover: 0, available: 0,
        actual: a.actual ?? 0, remaining: 0, pct: 0, projected: a.actual ?? 0, prior_actual: 0,
      };
      lines = [...lines, line];
      addable = addable.filter((x) => x.category_id !== categoryId);
    }
    const next: ProgressLine = { ...line };
    if (edit.amount !== undefined) {
      next.budgeted = edit.amount;
      next.one_month = edit.scope === "month";
    }
    if (edit.bucket && edit.bucket !== line.bucket) {
      next.bucket = edit.bucket;
      next.position = lastPosition(lines, edit.bucket);
    }
    if (edit.rollover_enabled !== undefined) next.rollover_enabled = edit.rollover_enabled;
    lines = lines.map((l) => (l.category_id === categoryId ? next : l));
  }

  lines = lines.map(withFigures).sort((a, b) => a.position - b.position || b.budgeted - a.budgeted);
  const buckets = Object.fromEntries(BUCKETS.map((b) => {
    const mine = lines.filter((l) => l.bucket === b);
    const sum = (k: "budgeted" | "actual" | "available") => mine.reduce((s, l) => s + l[k], 0);
    return [b, { budgeted: sum("budgeted"), actual: sum("actual"), available: sum("available"),
      remaining: sum("available") - sum("actual") }];
  })) as BudgetProgress["buckets"];
  const allocated = lines.reduce((s, l) => s + l.budgeted, 0);
  const totalSpent = lines.reduce((s, l) => s + l.actual, 0);
  return {
    ...base,
    lines,
    addable: addable.sort((a, b) => Number(b.hidden) - Number(a.hidden) || a.name.localeCompare(b.name)),
    buckets,
    allocated,
    total_spent: totalSpent,
    safe_to_spend: base.total_budget - totalSpent,
  };
}

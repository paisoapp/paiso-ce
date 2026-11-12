import { useEffect, useState } from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CategoryIcon } from "@/lib/categoryIcons";
import { useCategoryImpact, useMoveCategory } from "@/hooks/useCategories";
import type { Category } from "@/types";

type Mode = "keep" | "merge" | "uncategorize";

const COUNTS_AS: Record<string, string> = { income: "income", expense: "spending", transfer: "a transfer, left out of income and spending" };

/**
 * Confirms moving a category to another group. It says what changes
 * (its transactions count the way the new group counts, past months
 * included; budgets that use it) and asks where its transactions go: keep
 * it as its own category in the group (recommended), merge it into one
 * already there, or move them to Uncategorized.
 */
export function MoveCategoryDialog({
  category,
  group,
  groupCategories,
  onClose,
}: {
  category: Category | null;
  group: Category | null;
  /** The categories already in the target group, to merge into. */
  groupCategories: Category[];
  onClose: () => void;
}) {
  const open = category != null && group != null;
  const { data: impact } = useCategoryImpact(open ? category.id : null);
  const move = useMoveCategory();
  const [mode, setMode] = useState<Mode>("keep");
  const [mergeInto, setMergeInto] = useState<number | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setMode("keep");
    setMergeInto(groupCategories[0]?.id ?? null);
    setError("");
  }, [category?.id, group?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const tx = impact?.transactions ?? 0;
  const confirm = () =>
    move.mutate(
      { id: category.id, group_id: group.id, mode, ...(mode === "merge" && mergeInto ? { merge_into_id: mergeInto } : {}) },
      { onSuccess: onClose, onError: (e) => setError((e as Error).message) },
    );

  const option = (value: Mode, title: string, body: string, extra?: React.ReactNode) => (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
        mode === value ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-border hover:bg-muted/40"
      }`}
    >
      <input type="radio" name="move-mode" checked={mode === value} onChange={() => setMode(value)}
        className="mt-1 accent-[hsl(var(--primary))]" aria-label={title} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
        {extra}
      </span>
    </label>
  );

  return (
    <Dialog open onClose={onClose}>
      <DialogHeader onClose={onClose}>
        Move <CategoryIcon name={category.name} icon={category.icon} size={14} /> {category.name} to{" "}
        <CategoryIcon name={group.name} icon={group.icon} size={14} /> {group.name}
      </DialogHeader>
      <DialogBody className="space-y-3">
        <p className="text-sm">
          {impact ? (
            <>
              {category.name} has {tx} transaction{tx === 1 ? "" : "s"}
              {impact.rules > 0 && ` and ${impact.rules} auto-categorize rule${impact.rules === 1 ? "" : "s"}`}.
            </>
          ) : "Counting its transactions…"}{" "}
          In {group.name}, they count as {COUNTS_AS[group.treatment ?? "expense"] ?? "spending"} in every report, past months included.
        </p>
        {impact && impact.budgets.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Used in {impact.budgets.join(", ")}.
            {group.treatment === "income" && " An income category cannot be budgeted, so it leaves those budgets from this month."}
          </p>
        )}
        <div className="space-y-2" role="radiogroup" aria-label="Where its transactions go">
          {option("keep", `Keep ${category.name} as its own category in ${group.name} (recommended)`,
            "Its name, emoji, transactions and rules stay with it.")}
          {option("merge", `Merge it into a category in ${group.name}`,
            `Its transactions and rules move to the category you pick, and ${category.name} is deleted.`,
            mode === "merge" && (
              groupCategories.length > 0 ? (
                <select
                  value={mergeInto ?? ""}
                  onChange={(e) => setMergeInto(Number(e.target.value))}
                  aria-label="Merge into"
                  className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                >
                  {groupCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : <span className="mt-1 block text-xs text-destructive">{group.name} has no categories yet.</span>
            ))}
          {option("uncategorize", "Move its transactions to Uncategorized",
            `They lose their category, its rules are removed, and ${category.name} is deleted.`)}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          onClick={confirm}
          loading={move.isPending}
          disabled={move.isPending || (mode === "merge" && !mergeInto)}
          variant={mode === "keep" ? "primary" : "destructive"}
        >
          Move
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

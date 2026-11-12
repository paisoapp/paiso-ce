import { useState } from "react";
import { Check, ChevronDown, Copy, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn, formatCurrency } from "@/lib/utils";
import {
  useActivateProfile,
  useCreateProfile,
  useDeleteProfile,
  usePlans,
  type BudgetPlan,
} from "@/hooks/useBudgetPlan";

/**
 * Names the budget in use and lists the others. A second budget is how someone
 * tries a different split — a leaner month, a higher savings rate — without
 * overwriting the one they are living by; switching is what puts it to work.
 */
export function BudgetSwitcher({ plan, onNew, guard = (then) => then() }: {
  plan: BudgetPlan;
  onNew: () => void;
  /** Asks before unsaved changes on the Budget tab are dropped. */
  guard?: (then: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMobile = useIsMobile();
  const { data } = usePlans();
  const activate = useActivateProfile();
  const create = useCreateProfile();
  const remove = useDeleteProfile();

  const plans = data?.plans ?? [];
  const atLimit = plans.length >= (data?.max ?? Infinity);
  const isOnly = plans.length <= 1;
  const itemCls = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left transition-colors hover:bg-muted disabled:opacity-50 disabled:hover:bg-transparent";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex max-w-[14rem] items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted transition-colors"
      >
        <span className="truncate">{plan.name}</span>
        <ChevronDown size={12} className="shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div className={cn("fixed inset-0", isMobile ? "z-40 bg-black/40" : "z-10")} onClick={() => setOpen(false)} />
          <div
            role="menu"
            className={cn(
              "rounded-xl border border-border bg-card shadow-xl p-2",
              isMobile
                ? "fixed inset-x-0 bottom-0 z-50 rounded-b-none border-x-0 border-b-0 max-h-[85dvh] overflow-y-auto pb-[calc(0.5rem+env(safe-area-inset-bottom))]"
                : "absolute right-0 top-full mt-1 z-20 w-72",
            )}
          >
            <p className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">Your budgets</p>
            {plans.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.is_active}
                disabled={activate.isPending}
                onClick={() => {
                  if (p.is_active) return setOpen(false);
                  guard(() => activate.mutate(p.id, { onSuccess: () => setOpen(false) }));
                }}
                className={cn(itemCls, p.is_active && "bg-primary/10 text-primary font-medium hover:bg-primary/10")}
              >
                <Check size={14} className={cn("shrink-0", !p.is_active && "invisible")} />
                <span className="flex-1 truncate">{p.name}</span>
                <span className={cn("tabular-nums text-xs", !p.is_active && "text-muted-foreground")}>
                  {formatCurrency(p.total_target ?? p.allocated)}/mo
                </span>
              </button>
            ))}

            <div className="my-2 border-t border-border" />
            <button
              type="button"
              role="menuitem"
              disabled={atLimit || create.isPending}
              onClick={() => guard(() => create.mutate({ copy_from: plan.id }, { onSuccess: () => setOpen(false) }))}
              className={itemCls}
            >
              <Copy size={14} className="shrink-0 text-muted-foreground" />
              Duplicate “{plan.name}”
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={atLimit}
              onClick={() => { setOpen(false); onNew(); }}
              className={itemCls}
            >
              <Plus size={14} className="shrink-0 text-muted-foreground" />
              New budget from scratch
            </button>
            {atLimit && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                You can keep up to {data?.max} budgets. Delete one to add another.
              </p>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); guard(() => setConfirmDelete(true)); }}
              className={cn(itemCls, "text-destructive")}
            >
              <Trash2 size={14} className="shrink-0" />
              {isOnly ? "Reset budget…" : `Delete “${plan.name}”…`}
            </button>
          </div>
        </>
      )}

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} className="md:max-w-md">
        <DialogHeader onClose={() => setConfirmDelete(false)}>
          {isOnly ? "Reset your budget?" : `Delete “${plan.name}”?`}
        </DialogHeader>
        <DialogBody className="space-y-2 text-sm text-muted-foreground">
          <p>
            This removes the budget's monthly total, its category amounts and any rollover it has built up.
            Your transactions and categories are not touched.
          </p>
          <p>
            {isOnly
              ? "You will be taken back to setup to start a new one."
              : "Your most recent other budget takes over."}
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate(plan.id, { onSuccess: () => setConfirmDelete(false) })}
          >
            {remove.isPending ? "Deleting…" : isOnly ? "Reset budget" : "Delete budget"}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

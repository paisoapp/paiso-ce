import { useState } from "react";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { formatRangeDates } from "@/components/ui/DateRangePicker";
import { MoneyInput } from "@/components/ui/MoneyInput";
import {
  useSetAllAmounts,
  useSuggestedIncome,
  useUpdatePlan,
  type BudgetPlan,
} from "@/hooks/useBudgetPlan";
import { formatCurrency } from "@/lib/utils";
import { budgetTotalCheck } from "./totalLimits";
import { ScopeChoice, monthName, type AmountScope } from "./ScopeChoice";
import { RolloverSwitch } from "./RolloverSwitch";

type AmountsChoice = "keep" | "averages" | "reset";

/**
 * Budget settings: the budget's name and monthly total, and
 * what to do with every amount at once (keep them, fill them from averages,
 * or reset them to $0). Nothing happens until Save; Cancel leaves the budget
 * as it was. Amounts one category at a time are set on the Budget tab, so
 * this screen has no grid of them. `month` is the month the amounts start from.
 */
export function BudgetSettings({ plan, month, onClose }: { plan: BudgetPlan; month: string; onClose: () => void }) {
  const { data: incomeData } = useSuggestedIncome(plan.trailing_months);
  const update = useUpdatePlan();
  const setAll = useSetAllAmounts();
  const startingTotal = plan.total_target ?? plan.lines.reduce((s, l) => s + l.amount, 0);
  const [name, setName] = useState(plan.name);
  const [totalText, setTotalText] = useState(startingTotal ? String(startingTotal) : "");
  const [amounts, setAmounts] = useState<AmountsChoice>("keep");
  const [scope, setScope] = useState<AmountScope>("onward");
  const [failed, setFailed] = useState(false);
  // The budget-wide rollover switch: on when every category is.
  const shown = plan.lines.filter((l) => !l.hidden);
  const onCount = shown.filter((l) => l.rollover_enabled).length;
  const mixed = onCount > 0 && onCount < shown.length;
  const startingRollover = shown.length > 0 ? onCount === shown.length : plan.rollover_default;
  const [rollover, setRollover] = useState(startingRollover);
  const rolloverChanged = rollover !== startingRollover;
  const total = Number(totalText) || 0;
  const suggested = incomeData?.monthly_income ?? 0;
  const totalCheck = budgetTotalCheck(total, suggested);
  const totalChanged = Math.abs(total - startingTotal) >= 0.005;
  const settingsChanged = totalChanged || (name.trim() || plan.name) !== plan.name || rolloverChanged;
  const changed = settingsChanged || amounts !== "keep";
  const saving = update.isPending || setAll.isPending;
  const when = scope === "onward" ? `from ${monthName(month)} on` : `for ${monthName(month)} only`;
  const inputCls = "rounded-md border border-border bg-background px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary/50";

  // Filling or resetting every category asks first, then says what it did.
  const [confirming, setConfirming] = useState(false);
  const count = plan.lines.length;

  async function save() {
    // Switching every category overrides the ones set by hand, so it asks first.
    if ((amounts !== "keep" || (rolloverChanged && mixed)) && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setFailed(false);
    try {
      if (settingsChanged) {
        await update.mutateAsync({
          name: name.trim() || plan.name,
          total_target: total,
          // A typed total is the user's own figure from here on.
          ...(totalChanged ? { income_basis: "manual" } : {}),
          ...(rolloverChanged ? { rollover_default: rollover } : {}),
        });
      }
      if (amounts !== "keep") {
        await setAll.mutateAsync({ action: amounts, scope, month });
        toast(
          amounts === "averages"
            ? `${count} categor${count === 1 ? "y" : "ies"} set to their averages ${when}`
            : `Every category set to $0 ${when}`,
          { description: "Earlier months keep their amounts.", variant: "success" },
        );
      } else {
        toast("Budget settings saved", { variant: "success" });
      }
      onClose();
    } catch {
      setFailed(true);
    }
  }

  const choice = (value: AmountsChoice, title: string, body: string) => (
    <label
      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
        amounts === value ? "border-primary ring-2 ring-primary/20 bg-primary/5" : "border-border hover:bg-muted/40"
      }`}
    >
      <input type="radio" name="amounts" value={value} checked={amounts === value}
        onChange={() => setAmounts(value)} className="mt-1 accent-[hsl(var(--primary))]" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{body}</span>
      </span>
    </label>
  );

  return (
    <div className="space-y-4 max-w-2xl">
      <h2 className="text-xl font-semibold">Budget settings</h2>

      <section className="rounded-xl border border-border bg-card p-4 space-y-4">
        <label className="block">
          <span className="text-xs text-muted-foreground">Name</span>
          <input type="text" value={name} maxLength={60} onChange={(e) => setName(e.target.value)}
            className={`mt-1 w-full text-sm ${inputCls}`} />
        </label>
        <div>
          <label htmlFor="budget-total" className="text-xs text-muted-foreground">Monthly total</label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-lg text-muted-foreground">$</span>
            <MoneyInput
              id="budget-total"
              allowNegative={false}
              value={totalText}
              onValueChange={setTotalText}
              placeholder="0"
              aria-invalid={totalCheck.error ? true : undefined}
              className={`w-36 text-lg tabular-nums ${inputCls} ${totalCheck.error ? "border-destructive" : ""}`}
            />
            <span className="text-sm text-muted-foreground">/mo</span>
            {suggested > 0 && Math.abs(suggested - total) >= 0.5 && (
              <button
                type="button"
                onClick={() => setTotalText(String(Math.round(suggested * 100) / 100))}
                className="text-xs px-2.5 py-1 rounded-md border border-border hover:bg-muted transition-colors"
              >
                Use my average income ({formatCurrency(suggested)}
                {incomeData?.from && incomeData?.to ? `, ${formatRangeDates({ from: incomeData.from, to: incomeData.to })}` : ""})
              </button>
            )}
          </div>
          {totalCheck.error && <p role="alert" className="mt-1 text-xs text-destructive">{totalCheck.error}</p>}
          {totalCheck.warning && <p className="mt-1 text-xs text-warning">{totalCheck.warning}</p>}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Every category at once</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            To change one category, use its Allocated field on the Budget tab.
          </p>
        </div>
        <div className="space-y-2" role="radiogroup" aria-label="Every category at once">
          {choice("keep", "Keep the amounts as they are", "Only the name, monthly total and rollover change.")}
          {choice(
            "averages",
            "Fill from my averages",
            `Each category to what you spent there in an average month, over your last ${plan.trailing_months} whole months. Categories you removed stay removed.`,
          )}
          {choice(
            "reset",
            "Reset every category to $0",
            "Start the split again. Categories you removed come back at $0.",
          )}
        </div>
        {amounts !== "keep" && (
          <>
            <ScopeChoice month={month} value={scope} onChange={setScope} what="the amounts" />
            <p className="text-xs text-muted-foreground">
              {amounts === "averages" ? "Every category goes to its average" : "Every category goes to $0"} {when}. Earlier
              months keep their amounts.
            </p>
          </>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Rollover</h3>
        <RolloverSwitch on={rollover} onChange={setRollover} mixed={mixed ? { on: onCount, of: shown.length } : undefined} />
      </section>

      {failed && <p role="alert" className="text-sm text-destructive">That did not save. Try again.</p>}
      <Dialog open={confirming} onClose={() => setConfirming(false)} className="md:max-w-md">
        <DialogHeader onClose={() => setConfirming(false)}>
          {amounts === "averages" ? "Fill every category from your averages?"
            : amounts === "reset" ? "Reset every category to $0?"
            : `Turn rollover ${rollover ? "on" : "off"} for every category?`}
        </DialogHeader>
        <DialogBody>
          {amounts !== "keep" && (
            <p className="text-sm text-muted-foreground">
              {amounts === "averages"
                ? `Each of the ${count} categories on this budget goes to its average ${when}.`
                : `Each category goes to $0 ${when}, and removed ones come back at $0.`}{" "}
              Earlier months keep their amounts.
            </p>
          )}
          {rolloverChanged && mixed && (
            <p className="text-sm text-muted-foreground mt-2">
              Rollover is on for {onCount} of {shown.length} categories now. Saving turns it {rollover ? "on" : "off"} for
              all {shown.length}.
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <button type="button" onClick={() => setConfirming(false)}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">
            Cancel
          </button>
          <button type="button" onClick={save}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90">
            {amounts === "averages" ? "Fill from averages" : amounts === "reset" ? "Reset to $0" : "Save"}
          </button>
        </DialogFooter>
      </Dialog>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm rounded-md border border-border hover:bg-muted">
          Cancel
        </button>
        <button
          onClick={save}
          disabled={!changed || !!totalCheck.error || saving}
          className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

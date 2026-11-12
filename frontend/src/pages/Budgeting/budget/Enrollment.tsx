import { useEffect, useState } from "react";
import { Sparkles, Wallet } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { formatRangeDates } from "@/components/ui/DateRangePicker";
import {
  useCreateProfile,
  useEnroll,
  useRecommendations,
  useSuggestedIncome,
  type BudgetLine,
  type EnrollBody,
} from "@/hooks/useBudgetPlan";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { budgetTotalCheck } from "./totalLimits";
import { RolloverSwitch } from "./RolloverSwitch";

type Start = "averages" | "zero";

/**
 * First-time setup, and, with `onCancel`, an additional budget, saved beside
 * the existing ones and switched to. One screen: a monthly total and
 * how to start the amounts, then straight to the Budget tab, where every
 * amount, bucket and category is changed in place. The categories are the
 * ones the user spends in, each at its average or at $0.
 */
export function Enrollment({ onCancel, onDone }: { onCancel?: () => void; onDone?: () => void } = {}) {
  const additional = !!onCancel;
  const [name, setName] = useState("");
  const [basis, setBasis] = useState<"manual" | "auto">("auto");
  const [manualText, setManualText] = useState("");
  const [start, setStart] = useState<Start>("averages");
  const manualTotal = Number(manualText) || 0;
  // Create stays enabled and says why it cannot go on.
  const [tried, setTried] = useState(false);
  const { data: incomeData } = useSuggestedIncome();
  const suggested = incomeData?.monthly_income ?? 0;
  // No income to average: start on "Set my own total" rather than on $0.
  useEffect(() => {
    if (incomeData && incomeData.monthly_income <= 0) setBasis("manual");
  }, [incomeData]);
  const { data: recs = [] } = useRecommendations(suggested, 3);
  const enroll = useEnroll();
  const createProfile = useCreateProfile();
  const saving = enroll.isPending || createProfile.isPending;

  const [rollover, setRollover] = useState(false);
  const total = basis === "auto" ? suggested : manualTotal;
  const totalCheck = budgetTotalCheck(total, suggested);
  const totalError =
    total > 0
      ? totalCheck.error ?? null
      : basis === "auto"
        ? "There is no recent income to average yet. Set your own total instead."
        : "Enter a monthly total above $0.";

  // The categories with spending in the last three whole months; with none
  // yet (a new account), every budgetable category, so there is something to fill in.
  const spent = recs.filter((r) => r.trailing_avg > 0);
  const chosen = spent.length > 0 ? spent : recs;
  const averageTotal = spent.reduce((s, r) => s + r.trailing_avg, 0);

  function create() {
    setTried(true);
    if (totalError) return;
    const lines: BudgetLine[] = chosen.map((r) => ({
      category_id: r.category_id,
      amount: start === "averages" ? r.trailing_avg : 0,
      bucket: r.bucket,
      rollover_enabled: rollover,
    }));
    const body: EnrollBody = { total_target: total, income_basis: basis, rollover_default: rollover, lines };
    if (additional) createProfile.mutate({ ...body, name: name.trim() || undefined }, { onSuccess: onDone });
    else enroll.mutate(body);
  }

  const optionCls = (on: boolean) =>
    `w-full text-left rounded-xl border p-4 transition-colors ${
      on ? "border-primary ring-2 ring-primary/30 bg-primary/5" : "border-border hover:bg-muted/40"
    }`;

  return (
    <div className="max-w-lg mx-auto space-y-5 py-6">
      <div className="text-center space-y-1">
        <div className="inline-flex rounded-full bg-primary/10 p-3 mb-1">
          <Wallet size={28} className="text-primary" />
        </div>
        <h2 className="text-xl font-semibold">{additional ? "New budget" : "Set up your budget"}</h2>
        <p className="text-sm text-muted-foreground">
          {additional
            ? "A separate budget to try a different split. Your current one is kept, and you can switch back at any time."
            : "Pick a monthly total and how to start. You set each category's amount on the Budget tab."}
        </p>
      </div>

      {additional && (
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <input
            type="text"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Lean months"
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </label>
      )}

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Monthly total</p>
        <button onClick={() => { setBasis("auto"); setTried(false); }} className={optionCls(basis === "auto")}>
          <div className="flex items-center gap-2 mb-1">
            <Sparkles size={16} className="text-primary" />
            <span className="text-sm font-semibold">Use my average income</span>
          </div>
          <p className="text-2xl font-bold tabular-nums">{formatCurrency(suggested)}<span className="text-sm font-normal text-muted-foreground">/mo</span></p>
          <p className="text-xs text-muted-foreground">
            {incomeData?.from && incomeData?.to
              ? `Average monthly income for ${formatRangeDates({ from: incomeData.from, to: incomeData.to })}, the last 3 whole months.`
              : "Average of your last 3 whole months of income."}
          </p>
        </button>
        <button onClick={() => { setBasis("manual"); setTried(false); }} className={optionCls(basis === "manual")}>
          <div className="text-sm font-semibold mb-2">Set my own total</div>
          <div className="flex items-center gap-1">
            <span className="text-lg text-muted-foreground">$</span>
            <MoneyInput
              allowNegative={false}
              value={manualText}
              onClick={(e) => { e.stopPropagation(); setBasis("manual"); }}
              onValueChange={(v) => { setManualText(v); setTried(false); }}
              placeholder="0"
              aria-label="Monthly total"
              aria-invalid={tried && basis === "manual" && totalError ? true : undefined}
              className={`w-40 rounded-md border bg-background px-3 py-1.5 text-lg tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50 ${
                tried && basis === "manual" && totalError ? "border-destructive" : "border-border"
              }`}
            />
            <span className="text-sm text-muted-foreground">/mo</span>
          </div>
        </button>
        {tried && totalError && <p role="alert" className="text-xs text-destructive">{totalError}</p>}
        {basis === "manual" && totalCheck.warning && <p className="text-xs text-warning">{totalCheck.warning}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Start the amounts</p>
        <button onClick={() => setStart("averages")} className={optionCls(start === "averages")} disabled={spent.length === 0}>
          <div className="text-sm font-semibold">Fill from my averages</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {spent.length > 0
              ? `${spent.length} categories you spend in, each at its average for the last 3 whole months (${formatCurrency(averageTotal)} in all).`
              : "There is no spending to average yet."}
          </p>
        </button>
        <button onClick={() => setStart("zero")} className={optionCls(start === "zero" || spent.length === 0)}>
          <div className="text-sm font-semibold">Start every category at $0</div>
          <p className="text-xs text-muted-foreground mt-0.5">
            The same categories, each at $0, for you to fill in on the Budget tab.
          </p>
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">Rollover</p>
        <RolloverSwitch on={rollover} onChange={setRollover} />
      </div>

      {start === "averages" && spent.length > 0 && total > 0 && averageTotal > total && (
        // The averages alone are more than the total: the budget would start
        // with less than nothing left to assign.
        <div role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs space-y-2">
          <p>
            Your averages come to {formatCurrency(averageTotal)}, which is {formatCurrency(averageTotal - total)} more
            than a total of {formatCurrency(total)}. The budget would start with{" "}
            {formatCurrency(total - averageTotal)} left to assign.
          </p>
          <button
            type="button"
            onClick={() => { setBasis("manual"); setManualText(String(Math.round(averageTotal))); setTried(false); }}
            className="rounded-md border border-border bg-background px-2.5 py-1 hover:bg-muted"
          >
            Use {formatCurrency(Math.round(averageTotal))} as my total
          </button>
        </div>
      )}

      <div className="flex gap-2">
        {onCancel && (
          <button onClick={onCancel} className="flex-1 px-4 py-2.5 text-sm rounded-md border border-border hover:bg-muted">
            Cancel
          </button>
        )}
        <button
          onClick={create}
          disabled={saving}
          className="flex-1 px-4 py-2.5 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saving ? "Creating…" : "Create budget"}
        </button>
      </div>
    </div>
  );
}

import { useState } from "react";
import { usePlan } from "@/hooks/useBudgetPlan";
import { Enrollment } from "./budget/Enrollment";
import { BudgetDashboard } from "./budget/BudgetDashboard";
import { BudgetSettings } from "./budget/BudgetSettings";

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

type Mode = "view" | "edit" | "new";

export function PerformancePage() {
  const { data: plan, isLoading } = usePlan();
  const [month, setMonth] = useState<string>(currentMonth());
  const [mode, setMode] = useState<Mode>("view");

  if (isLoading) {
    return (
      <div className="h-64 flex items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!plan || !plan.enrolled) {
    return <Enrollment />;
  }

  if (mode === "new") {
    return <Enrollment onCancel={() => setMode("view")} onDone={() => setMode("view")} />;
  }

  if (mode === "edit") {
    // Keyed by budget so the form never carries one budget's draft into another.
    // Actions start from the month on screen, or this month if that is past.
    const from = month > currentMonth() ? month : currentMonth();
    return <BudgetSettings key={plan.id} plan={plan} month={from} onClose={() => setMode("view")} />;
  }

  return (
    <BudgetDashboard
      plan={plan}
      month={month}
      onMonthChange={setMonth}
      onEdit={() => setMode("edit")}
      onNew={() => setMode("new")}
    />
  );
}

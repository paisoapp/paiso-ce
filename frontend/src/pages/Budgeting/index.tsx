import { useState } from "react";
import { Outlet, Routes, Route } from "react-router-dom";
import type { CompareSelection } from "@/components/ui/DateRangePicker";
import { PinnedTabRedirect, SectionTabs } from "@/components/ui/SectionTabs";
import { ExpensesPage } from "./ExpensesPage";
import { IncomePage } from "./IncomePage";
import { CashFlowPage } from "./CashFlowPage";
import { TransfersPage } from "./TransfersPage";
import { PerformancePage } from "./PerformancePage";
import { BudgetDateContext } from "./budgetContext";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import { AddAccountButton } from "@/components/accounts/AddAccountButton";

// ── Tabs ──────────────────────────────────────────────────────────────────────

/** The Cash Flow tabs. */
const BUDGETING_TABS = [
  { to: "overview", label: "Overview" },
  { to: "income", label: "Income" },
  { to: "expenses", label: "Expenses" },
  { to: "transfers", label: "Transfers" },
  { to: "budget", label: "Budget" },
];

function BudgetingShell() {
  const TABS = BUDGETING_TABS;
  // One range for the whole section, remembered between visits.
  const { dateRange, setDateRange } = useSectionDateRange("budgeting");
  // Held here rather than on each page: a comparison switched on for Expenses
  // used to be gone again on Income, one tab over.
  const [compare, setCompare] = useState<CompareSelection | null>(null);

  return (
    <BudgetDateContext.Provider value={{ dateRange, setDateRange, compare, setCompare }}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Cash Flow</h1>
          <AddAccountButton />
        </div>
        <SectionTabs items={TABS} pinSection="budgeting" />
        <Outlet />
      </div>
    </BudgetDateContext.Provider>
  );
}

/** Opens on the tab the user pinned, if any. */
function BudgetingIndex() {
  return <PinnedTabRedirect section="budgeting" items={BUDGETING_TABS} fallback="overview" />;
}

export function BudgetingPage() {
  return (
    <Routes>
      <Route element={<BudgetingShell />}>
        <Route index element={<BudgetingIndex />} />
        <Route path="overview" element={<CashFlowPage />} />
        <Route path="income" element={<IncomePage />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="transfers" element={<TransfersPage />} />
        <Route
          path="budget"
          element={<PerformancePage />}
        />
      </Route>
    </Routes>
  );
}

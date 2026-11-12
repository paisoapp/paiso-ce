import { Outlet, Route, Routes } from "react-router-dom";
import { PinnedTabRedirect, SectionTabs } from "@/components/ui/SectionTabs";
import { TransactionTable } from "./TransactionTable";
import { InvestmentActivity } from "./InvestmentActivity";
import { TransactionDateContext } from "./transactionContext";
import { useSectionDateRange } from "@/hooks/useSectionDateRange";
import { AddAccountButton } from "@/components/accounts/AddAccountButton";

const TABS = [
  { to: "all", label: "All" },
  { to: "cash", label: "Cash" },
  { to: "investments", label: "Investments" },
  { to: "credit-cards", label: "Credit Cards" },
  { to: "loan", label: "Loan" },
  { to: "mortgage", label: "Mortgage" },
];

function TransactionsShell() {
  const { dateRange, setDateRange } = useSectionDateRange("transactions");

  return (
    <TransactionDateContext.Provider value={{ dateRange, setDateRange }}>
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Transactions</h1>
          <AddAccountButton />
        </div>
        <SectionTabs items={TABS} pinSection="transactions" />
        <Outlet />
      </div>
    </TransactionDateContext.Provider>
  );
}

export function TransactionsPage() {
  return (
    <Routes>
      <Route element={<TransactionsShell />}>
        <Route index element={<PinnedTabRedirect section="transactions" items={TABS} fallback="all" />} />
        <Route path="all" element={<TransactionTable showBreakdown title="All Transactions" />} />
        <Route path="cash" element={<TransactionTable showBreakdown title="Cash Transactions" accountTypeGroup="cash" />} />
        <Route path="investments" element={<InvestmentActivity />} />
        <Route
          path="credit-cards"
          element={<TransactionTable showBreakdown title="Credit Card Transactions" accountTypeGroup="credit_cards" showMemberName excludeTransfers />}
        />
        <Route path="loan" element={<TransactionTable showBreakdown title="Loan Transactions" accountTypeGroup="loan" />} />
        <Route path="mortgage" element={<TransactionTable showBreakdown title="Mortgage Transactions" accountTypeGroup="mortgage" />} />
      </Route>
    </Routes>
  );
}

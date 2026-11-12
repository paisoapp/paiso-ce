import { Outlet, Navigate, Routes, Route } from "react-router-dom";
import { PinnedTabRedirect, SectionTabs } from "@/components/ui/SectionTabs";
import { StocksPage } from "./StocksPage";
import { OverviewPage } from "./OverviewPage";
import { PlansTab } from "./PlansTab";
import { PropertyPage } from "./PropertyPage";
import { OtherAssetsPage } from "./OtherAssetsPage";
import { AddAccountButton } from "@/components/accounts/AddAccountButton";

// One tab per investment type: an account lives on the tab for what it is for
// (its type), whatever its legal sub-type. Crypto is under Stocks & Funds.
const INVESTMENT_TABS = [
  { to: "overview", label: "Overview" },
  { to: "stocks", label: "Stocks & Funds" },
  { to: "retirement", label: "Retirement" },
  { to: "education", label: "Education" },
  { to: "health", label: "Health" },
  { to: "property", label: "Property" },
  { to: "other", label: "Other Assets" },
];

function InvestmentsShell() {
  const TABS = INVESTMENT_TABS;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Investments</h1>
        <AddAccountButton />
      </div>
      <SectionTabs items={TABS} pinSection="investments" />
      <Outlet />
    </div>
  );
}

/** Opens on the tab the user pinned, if any. */
function InvestmentsIndex() {
  return <PinnedTabRedirect section="investments" items={INVESTMENT_TABS} fallback="overview" />;
}

export function InvestmentsPage() {
  return (
    <Routes>
      <Route element={<InvestmentsShell />}>
        <Route index element={<InvestmentsIndex />} />
        <Route path="overview" element={<OverviewPage />} />
        <Route path="stocks" element={<StocksPage />} />
        <Route path="retirement" element={
          <PlansTab type="retirement" emptyHint="No retirement accounts yet. Add a 401(k), IRA or other retirement account." />} />
        <Route path="education" element={
          <PlansTab type="education" emptyHint="No education accounts yet. Add a 529 plan, Coverdell ESA or an account you save for school in." />} />
        <Route path="health" element={
          <PlansTab type="health" emptyHint="No health accounts yet. Add an HSA." />} />
        <Route path="education-legacy" element={<Navigate to="../education" replace />} />
        {/* Older links. */}
        <Route path="529" element={<Navigate to="../education" replace />} />
        <Route path="401k" element={<Navigate to="../retirement" replace />} />
        <Route path="hsa" element={<Navigate to="../health" replace />} />
        <Route path="allocation" element={<Navigate to="../overview" replace />} />
        <Route path="property" element={<PropertyPage />} />
        <Route path="other" element={<OtherAssetsPage />} />
      </Route>
    </Routes>
  );
}

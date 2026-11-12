import { createContext, useContext } from "react";
import { type CompareSelection, type DateRange, defaultRange } from "@/components/ui/DateRangePicker";

export const BudgetDateContext = createContext<{
  dateRange: DateRange | null;
  setDateRange: (r: DateRange | null) => void;
  /** The comparison period, shared by every Budgeting tab like the range is. */
  compare: CompareSelection | null;
  setCompare: (c: CompareSelection | null) => void;
}>({
  dateRange: defaultRange(),
  setDateRange: () => {},
  compare: null,
  setCompare: () => {},
});

export function useBudgetDateRange() {
  return useContext(BudgetDateContext);
}

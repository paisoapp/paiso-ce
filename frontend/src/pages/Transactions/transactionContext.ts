import { createContext, useContext } from "react";
import { type DateRange, defaultRange } from "@/components/ui/DateRangePicker";

export const TransactionDateContext = createContext<{
  dateRange: DateRange | null;
  setDateRange: (r: DateRange | null) => void;
}>({
  dateRange: defaultRange(),
  setDateRange: () => {},
});

export function useTransactionDateRange() {
  return useContext(TransactionDateContext);
}

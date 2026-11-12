import { formatCurrency } from "@/lib/utils";

/** The most a monthly budget can be; the API refuses more. */
const MAX_MONTHLY_BUDGET = 10_000_000;

/** What is wrong with a typed monthly total: an `error` blocks saving, a
 *  `warning` is only a nudge (a total far above income is usually a typo). */
export function budgetTotalCheck(total: number, income: number): { error?: string; warning?: string } {
  if (total > MAX_MONTHLY_BUDGET) {
    return { error: `A monthly budget can be at most ${formatCurrency(MAX_MONTHLY_BUDGET)}. Check for extra digits.` };
  }
  if (income > 0 && total > income * 3) {
    return { warning: `This is more than three times your average monthly income of ${formatCurrency(income)}.` };
  }
  return {};
}

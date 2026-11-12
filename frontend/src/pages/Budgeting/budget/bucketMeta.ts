import type { Bucket } from "@/hooks/useBudgetPlan";

export const BUCKETS: Bucket[] = ["needs", "wants", "savings"];

/** Names, hints and colors for the three buckets, shared by the
 *  Budget tab and the budget editor. */
export const BUCKET_META: Record<Bucket, { label: string; hint: string; color: string }> = {
  needs: {
    label: "Needs",
    hint: "Bills you must pay: housing, utilities, groceries, insurance, minimum loan payments.",
    color: "#3b82f6",
  },
  wants: {
    label: "Wants",
    hint: "Spending you choose: dining out, shopping, travel, entertainment.",
    color: "#f59e0b",
  },
  savings: {
    label: "Savings & Debt",
    hint: "Paying your future self: savings, investing, and paying down debt beyond the minimum.",
    color: "#10b981",
  },
};

/**
 * Status color by how much of the available amount is used.
 * The goal is to use the amount, so landing on it is green and money still
 * unused is blue, not a warning: blue under 95%, green from 95% (or within
 * $5) to the amount, amber up to 10% over, red past that.
 */
export function barColor(actual: number, available: number): string {
  if (available <= 0) return actual > 0.5 ? BAR.over : BAR.under;
  if (actual > available * 1.1) return BAR.over;
  if (actual - available > 0.5) return BAR.near;
  if (actual >= available * 0.95 || available - actual <= 5) return BAR.met;
  return BAR.under;
}

const BAR = {
  under: "#3b82f6",
  met: "hsl(var(--success))",
  near: "hsl(var(--warning))",
  over: "hsl(var(--destructive))",
};

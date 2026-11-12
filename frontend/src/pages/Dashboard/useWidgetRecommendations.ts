import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useDashboardData } from "@/hooks/useDashboard";
import type { Holding } from "@/hooks/useHoldings";
import type { PlanResponse } from "@/hooks/useBudgetPlan";
import { recommendWidgets, type Recommendation } from "./widgets/registry";

/**
 * Widgets worth suggesting for this user's actual data.
 *
 * Only fetches while `enabled` (the suggestion banner is up or the Add Widget
 * dialog is open), so a user who dismissed the suggestions pays nothing for
 * them. Query keys match the pages' own hooks, so the cache is shared.
 */
export function useWidgetRecommendations(
  enabled: boolean,
  placed: Set<string>,
): Recommendation[] {
  const { data: dash } = useDashboardData();

  const { data: holdings } = useQuery<Holding[]>({
    queryKey: ["holdings"],
    queryFn: () => api.get<Holding[]>("/holdings"),
    enabled,
  });
  const { data: plan } = useQuery<PlanResponse>({
    queryKey: ["budget", "plan"],
    queryFn: () => api.get<PlanResponse>("/budget/plan"),
    enabled,
  });

  if (!enabled || !dash) return [];
  return recommendWidgets(
    {
      investmentValue: dash.investment_value,
      hasDebt: dash.total_liabilities > 0,
      budgetEnrolled: !!plan?.enrolled,
      hasHoldings: (holdings ?? []).some((h) => !h.is_balance_account && h.current_value > 0),
    },
    placed,
  );
}

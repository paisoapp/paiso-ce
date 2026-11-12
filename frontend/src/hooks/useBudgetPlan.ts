import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Bucket = "needs" | "wants" | "savings";

export interface BudgetLine {
  category_id: number;
  amount: number;
  bucket: Bucket;
  rollover_enabled: boolean;
  /** Removed from the budget. Only this hides a line; a $0 line stays. */
  hidden?: boolean;
}

export interface BudgetPlan {
  enrolled: true;
  id: number;
  name: string;
  is_active: boolean;
  total_target: number | null;
  income_basis: "manual" | "auto";
  trailing_months: number;
  start_month: string;
  /** Whether a category added to the budget starts with rollover on. */
  rollover_default: boolean;
  lines: BudgetLine[];
}

export type PlanResponse = BudgetPlan | { enrolled: false };

interface Recommendation {
  category_id: number;
  name: string;
  color: string | null;
  bucket: Bucket;
  trailing_avg: number;
  benchmark: number | null;
}

export interface ProgressLine {
  category_id: number;
  name: string;
  color: string | null;
  /** The category's emoji. */
  icon?: string | null;
  bucket: Bucket;
  /** Order inside its bucket, set by dragging. */
  position: number;
  rollover_enabled: boolean;
  /** This month's amount is a change for this month only. */
  one_month: boolean;
  budgeted: number;
  carryover: number;
  available: number;
  actual: number;
  remaining: number;
  pct: number;
  projected: number;
  prior_actual: number;
}

export interface BucketRollup {
  budgeted: number;
  actual: number;
  available: number;
  remaining: number;
}

export interface BudgetProgress {
  enrolled: boolean;
  month: string;
  is_current: boolean;
  /** The month is earlier than the budget: shown for reference, not graded. */
  before_start: boolean;
  total_budget: number;
  allocated: number;
  total_spent: number;
  safe_to_spend: number;
  unbudgeted_spend: number;
  days_in_month: number;
  days_remaining: number;
  month_pct_elapsed: number;
  buckets: Record<Bucket, BucketRollup>;
  lines: ProgressLine[];
  /** Categories that can be added: removed ones first, then the rest. */
  addable: AddableCategory[];
}

export interface AddableCategory {
  category_id: number;
  name: string;
  icon?: string | null;
  /** Removed from this budget; it comes back with `last_amount`. */
  hidden: boolean;
  last_amount: number;
  bucket: Bucket;
  /** Spent this month, for its Used figure when it is added back. */
  actual?: number;
}

/** What the Allocated and Used pop-ups show for one category. */
interface CategoryDetail {
  category_id: number;
  name: string;
  month: string;
  history: { month: string; label: string; spent: number }[];
  last_month: number;
  average: number;
  transactions: { id: number; date: string; description: string; amount: number }[];
}

/** One of the user's budgets, as listed in the switcher. */
interface BudgetProfile {
  id: number;
  name: string;
  is_active: boolean;
  total_target: number | null;
  allocated: number;
}

const PLAN_QK = ["budget", "plan"];
const PLANS_QK = ["budget", "plans"];

/** Every budget the user keeps. `usePlan` is the active one of these. */
export function usePlans() {
  return useQuery<{ max: number; plans: BudgetProfile[] }>({
    queryKey: PLANS_QK,
    queryFn: () => api.get("/budget/plans"),
  });
}

export function usePlan() {
  return useQuery<PlanResponse>({
    queryKey: PLAN_QK,
    queryFn: () => api.get<PlanResponse>("/budget/plan"),
  });
}

export function useSuggestedIncome(trailingMonths = 3) {
  /** `from`/`to` are the whole months averaged. */
  return useQuery<{ monthly_income: number; from?: string; to?: string }>({
    queryKey: ["budget", "suggested-income", trailingMonths],
    queryFn: () => api.get(`/budget/plan/suggested-income?trailing_months=${trailingMonths}`),
  });
}

export function useRecommendations(income: number, trailingMonths = 3) {
  return useQuery<Recommendation[]>({
    queryKey: ["budget", "recommendations", income, trailingMonths],
    queryFn: () =>
      api.get<Recommendation[]>(
        `/budget/plan/recommendations?income=${income}&trailing_months=${trailingMonths}`,
      ),
    enabled: income >= 0,
  });
}

/** `no_budget`: the month is earlier than the budget, so it is not graded. */
export type MonthStatus = "excelled" | "struggled" | "failed" | "none" | "no_budget";

export interface HistoryMonth {
  month: string;
  label: string;
  year: number;
  total_budget: number;
  total_spent: number;
  ratio: number | null;
  status: MonthStatus;
  is_current: boolean;
  /** Before the budget started: not graded, its spending shown for comparison. */
  before_start?: boolean;
}

export function useBudgetHistory(months = 12) {
  return useQuery<{ enrolled: boolean; months: HistoryMonth[] }>({
    queryKey: ["budget", "history", months],
    queryFn: () => api.get(`/budget/plan/history?months=${months}`),
  });
}

export function useBudgetProgress(month?: string) {
  return useQuery<BudgetProgress>({
    queryKey: ["budget", "progress", month ?? "current"],
    queryFn: () => api.get<BudgetProgress>(`/budget/plan/progress${month ? `?month=${month}` : ""}`),
  });
}

export interface EnrollBody {
  name?: string;
  total_target: number | null;
  income_basis: "manual" | "auto";
  trailing_months?: number;
  rollover_default?: boolean;
  lines: BudgetLine[];
}

function invalidatePlan(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: PLAN_QK });
  qc.invalidateQueries({ queryKey: PLANS_QK });
  qc.invalidateQueries({ queryKey: ["budget", "progress"] });
  qc.invalidateQueries({ queryKey: ["budget", "history"] });
  // Tips, bills still due and the forecast read the amounts too; without this
  // a tip stayed after its "Set to $X" was saved.
  qc.invalidateQueries({ queryKey: ["budget", "advice"] });
}

export function useEnroll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnrollBody) => api.post<BudgetPlan>("/budget/plan", body),
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useUpdatePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name?: string;
      total_target?: number | null;
      income_basis?: string;
      trailing_months?: number;
      /** The budget-wide rollover switch; every category follows it. */
      rollover_default?: boolean;
      /** Replaces the allocation along with the settings, in one save. */
      lines?: BudgetLine[];
    }) => api.put<BudgetPlan>("/budget/plan", body),
    onSuccess: () => invalidatePlan(qc),
  });
}

/** Add a budget: a copy of an existing one, or a new one from scratch. It
 *  becomes the active budget unless `activate` is false. */
export function useCreateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<EnrollBody> & { copy_from?: number; activate?: boolean }) =>
      api.post<BudgetPlan>("/budget/plans", body),
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useActivateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<BudgetPlan>(`/budget/plans/${id}/activate`, {}),
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useDeleteProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/budget/plans/${id}`),
    onSuccess: () => invalidatePlan(qc),
  });
}

export function useCategoryDetail(categoryId: number | null, month: string) {
  return useQuery<CategoryDetail>({
    queryKey: ["budget", "category", categoryId, month],
    queryFn: () => api.get<CategoryDetail>(`/budget/plan/category/${categoryId}?month=${month}`),
    enabled: categoryId != null,
    staleTime: 60_000,
  });
}

export interface LineEdit {
  amount?: number;
  /** "onward": this month and later; "month": this month only. */
  scope?: "onward" | "month";
  month?: string;
  bucket?: Bucket;
  rollover_enabled?: boolean;
  hidden?: boolean;
}

/** Saves the Budget tab's staged changes, one after another in the order
 *  they were made. On a failure the steps already sent stay
 *  saved; `done` says how many, so the rest can stay staged. */
export function useSaveDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (steps: import("@/pages/Budgeting/budget/budgetDraft").DraftStep[]) => {
      let done = 0;
      try {
        for (const step of steps) {
          if (step.kind === "order") await api.put("/budget/plan/order", step.order);
          else await api.patch(`/budget/plan/lines/${step.categoryId}`, step.edit);
          done += 1;
        }
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), { done });
      }
      return done;
    },
    // Waits for the month's figures, so the tab does not show the old ones
    // between the draft being cleared and the new ones arriving.
    onSettled: async () => {
      invalidatePlan(qc);
      qc.invalidateQueries({ queryKey: ["budget", "category"] });
      await qc.refetchQueries({ queryKey: ["budget", "progress"], type: "active" });
    },
  });
}

/** One category month by month, for its side drawer. */
interface CategoryReport {
  category_id: number;
  name: string;
  /** "week" under three calendar months: `weeks` and `days` are filled. */
  granularity: "month" | "week";
  /** Monday-start weeks cut to the range; allocated is the month's amount spread over its days. */
  weeks: { start: string; label: string; spent: number; allocated: number | null }[];
  /** Day by day: spent that day, the running total, and the allocation available so far. */
  days: { date: string; spent: number; cumulative: number; allocated: number | null }[];
  on_budget: boolean;
  rollover_enabled: boolean;
  amounts: { month: string; amount: number; scope: "onward" | "month" }[];
  months: {
    month: string;
    label: string;
    /** null before the budget started, or with no line for the category. */
    allocated: number | null;
    spent: number;
    carried_in: number | null;
    carried_out: number | null;
  }[];
}

export function useCategoryReport(categoryId: number | null, from: string, to: string) {
  return useQuery<CategoryReport>({
    queryKey: ["budget", "category", categoryId, "report", from, to],
    queryFn: () => api.get<CategoryReport>(`/budget/plan/category/${categoryId}/report?date_from=${from}&date_to=${to}`),
    enabled: categoryId != null && !!from && !!to,
    placeholderData: (prev) => prev,
  });
}

/** Budget settings: fill every line from its average, or reset all to $0. */
export function useSetAllAmounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { action: "averages" | "reset"; scope: "onward" | "month"; month?: string }) =>
      api.post<BudgetProgress>("/budget/plan/amounts", body),
    onSuccess: () => {
      invalidatePlan(qc);
      qc.invalidateQueries({ queryKey: ["budget", "category"] });
    },
  });
}

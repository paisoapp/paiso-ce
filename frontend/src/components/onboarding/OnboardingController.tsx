import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useAuthStore } from "@/store/auth";
import { useAccounts } from "@/hooks/useAccounts";
import { useAssets } from "@/hooks/useAssets";
import { useHoldings } from "@/hooks/useHoldings";
import { useMe, type Me } from "@/hooks/useMe";
import { useTransactions } from "@/hooks/useTransactions";
import { usePlan } from "@/hooks/useBudgetPlan";
import type { OnboardingAnswers } from "@/store/uiPrefs";
import { setupProgress, visibleSteps, type OnboardingData } from "./steps";
import { useOnboarding } from "./useOnboarding";
import { ResumeBanner } from "./ResumeBanner";

const LIABILITY_TYPES = new Set(["credit_card", "loan", "mortgage"]);

/** The completion signals that need no financial data: profile and answers. */
function accountSignals(
  me: Me | undefined,
  answers: OnboardingAnswers | undefined,
): Pick<OnboardingData, "hasProfile" | "hasGoals" | "hasFinances"> {
  return {
    hasProfile: !!(me?.first_name && me?.dob),
    hasGoals: (answers?.goals ?? []).length > 0,
    hasFinances: !!answers?.manage && (answers.have ?? []).length > 0,
  };
}

const NO_DATA = {
  accountCount: 0,
  hasAssets: false,
  hasLiabilities: false,
  mortgageWithoutHome: false,
  hasCategorized: false,
  budgetEnrolled: false,
};

/** Signals for an account that cannot read financial data yet. */
export function useAccountOnlyData(): { data: OnboardingData; loading: boolean } {
  const me = useMe();
  const { answers } = useOnboarding();
  return {
    data: { ...accountSignals(me.data, answers), ...NO_DATA },
    loading: me.isLoading,
  };
}

/** Assemble the data-derived completion signals from existing query hooks. */
export function useOnboardingData(): { data: OnboardingData; loading: boolean } {
  const accounts = useAccounts();
  const assets = useAssets();
  const holdings = useHoldings();
  const txns = useTransactions();
  const plan = usePlan();
  const me = useMe();
  const { answers } = useOnboarding();

  const accountList = accounts.data ?? [];
  const assetList = assets.data ?? [];

  const data: OnboardingData = {
    ...accountSignals(me.data, answers),
    accountCount: accountList.length,
    hasAssets: (holdings.data ?? []).length > 0 || assetList.length > 0,
    hasLiabilities:
      accountList.some((a) => LIABILITY_TYPES.has(a.account_type)) ||
      assetList.some((a) => !!a.loan),
    // Any mortgage with no property behind it: a second mortgage, or a
    // rental's, is missing its home even when another home is recorded.
    mortgageWithoutHome: accountList.some(
      (a) => a.account_type === "mortgage" && a.linked_asset_id == null,
    ),
    hasCategorized: (txns.data?.items ?? []).some((t) => t.category_id != null),
    budgetEnrolled: plan.data?.enrolled === true,
  };

  const loading =
    accounts.isLoading ||
    assets.isLoading ||
    holdings.isLoading ||
    txns.isLoading ||
    plan.isLoading;

  return { data, loading };
}

/** An account that predates the wizard and already holds data should never be
 *  walked through setup: move it out of "unstarted" quietly. New accounts are
 *  sent to /welcome at sign-up, which starts the flow itself. */
function ExistingUserGate() {
  const { dismiss } = useOnboarding();
  const { data, loading } = useOnboardingData();

  const isEmpty =
    data.accountCount === 0 && !data.hasAssets && !data.hasLiabilities && !data.budgetEnrolled;

  useEffect(() => {
    if (!loading && !isEmpty) dismiss();
  }, [loading, isEmpty, dismiss]);

  return null;
}

/** Active flow: a slim resume strip above the page, below the header. The
 *  full-page wizard lives at /welcome; the strip links back to it. */
function ActiveGuide() {
  const { completedSteps, complete, answers } = useOnboarding();
  const { data, loading } = useOnboardingData();
  const location = useLocation();

  // The same count the wizard shows: optional steps are offered there but
  // are not part of it, and setup is finished when everything owed is done.
  const { done, total } = setupProgress(
    visibleSteps(answers), data, completedSteps,
  );

  useEffect(() => {
    if (!loading && total > 0 && done === total) complete();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, done, total]);

  if (loading || location.pathname.startsWith("/welcome")) return null;
  return <ResumeBanner done={done} total={total} />;
}

/**
 * Single onboarding orchestrator, mounted once inside the authed shell, in
 * the page column above the content so the setup strip takes its own row. Only
 * mounts the data-fetching branch relevant to the current status, so dismissed
 * / completed users pay no query cost.
 */
export function OnboardingController() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const { status } = useOnboarding();

  if (!isAuthenticated) return null;
  if (status === "unstarted") return <ExistingUserGate />;
  if (status === "active") return <ActiveGuide />;
  return null;
}

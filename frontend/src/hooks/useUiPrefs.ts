import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useUiPrefsStore, type DashboardLayout, type DateRangeSection, type HeadlineFocus, type OnboardingState, type StoredRange, type TableSort } from "@/store/uiPrefs";

interface SettingsProfile {
  ui_prefs?: {
    sidebarCollapsed?: boolean;
    dateRanges?: Partial<Record<DateRangeSection, StoredRange>>;
    defaultLandingPage?: string;
    onboarding?: OnboardingState;
    dashboardLayout?: DashboardLayout | null;
    portfolioSectionOrder?: string[] | null;
    investmentsHeadlineFocus?: HeadlineFocus;
    tableSort?: Record<string, TableSort>;
    hiddenHoldingRows?: string[];
    investmentsSectionOrder?: string[] | null;
    investmentsCollapsed?: string[];
  } | null;
}

// Hydration is one-shot per account: the guard now lives in the uiPrefs store
// (hydratedForSession) and is reset on every sign-in/sign-out via
// resetForNewSession, so switching accounts on one browser re-adopts the new
// account's server value instead of inheriting the previous account's.

/**
 * Adopts cross-device UI preferences (remembered date ranges, sidebar state,
 * default landing page) from the backend once the user is authenticated.
 * Shares the "settings-profile" query with useTheme, so this adds no extra
 * network request.
 *
 * Returns `ready`: true once hydration has either completed or doesn't apply
 * (not authenticated) — callers that need to act on the *final* value of a
 * hydrated preference (e.g. redirecting to the default landing page) should
 * wait for this rather than reading the store immediately, since the local
 * value may still be a stale/default placeholder until the fetch resolves.
 */
export function useHydrateUiPrefs() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const hydrateFromServer = useUiPrefsStore((s) => s.hydrateFromServer);
  const hydrated = useUiPrefsStore((s) => s.hydratedForSession);
  const markHydrated = useUiPrefsStore((s) => s.markHydrated);

  const { data, isFetched } = useQuery<SettingsProfile>({
    queryKey: ["settings-profile"],
    queryFn: () => api.get<SettingsProfile>("/settings/profile"),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    if (data && !hydrated) {
      markHydrated();
      hydrateFromServer(data.ui_prefs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, data?.ui_prefs, hydrated]);

  return { ready: !isAuthenticated || isFetched };
}

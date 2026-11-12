import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAuthStore } from "@/store/auth";
import { useThemeStore, type Mode } from "@/store/theme";
import type { ThemeId } from "@/lib/themes";

export type { Mode } from "@/store/theme";

interface SettingsProfile {
  theme: string | null;
  theme_variant: string | null;
}

// One-shot guard (module-level so it survives component remounts). The server's
// stored theme should be adopted exactly ONCE per authenticated session; without
// this, every fresh `useTheme` mount — e.g. opening the Settings page, which
// mounts a second consumer — would re-run hydration with the stale cached server
// value and clobber a theme/mode the user just picked locally. Reset on logout so
// the next user hydrates fresh. [issue 6: theme randomly switches on Settings]
let hasHydratedTheme = false;

/**
 * Theme controller. Returns the shared theme/mode state plus setters, and
 * hydrates from the backend (UserSettings) once authenticated so a choice made
 * on another device is adopted here. Source-of-truth order: backend → local
 * cache → prefers-color-scheme (the latter two resolved in the store).
 */
export function useTheme() {
  const themeId = useThemeStore((s) => s.themeId);
  const mode = useThemeStore((s) => s.mode);
  const setTheme = useThemeStore((s) => s.setTheme);
  const setMode = useThemeStore((s) => s.setMode);
  const cycle = useThemeStore((s) => s.cycle);
  const hydrateFromServer = useThemeStore((s) => s.hydrateFromServer);

  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const { data } = useQuery<SettingsProfile>({
    queryKey: ["settings-profile"],
    queryFn: () => api.get<SettingsProfile>("/settings/profile"),
    enabled: isAuthenticated,
    staleTime: 5 * 60_000,
    // Local changes are authoritative after the initial hydration; don't let a
    // focus-triggered refetch re-apply a stale server value.
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    // Reset the one-shot guard on logout so the next login hydrates afresh.
    if (!isAuthenticated) {
      hasHydratedTheme = false;
      return;
    }
    if (data && !hasHydratedTheme) {
      hasHydratedTheme = true;
      hydrateFromServer(data.theme, data.theme_variant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, data?.theme, data?.theme_variant]);

  return {
    themeId,
    mode,
    setTheme: (id: ThemeId) => setTheme(id),
    setMode: (m: Mode) => setMode(m),
    cycle,
  };
}

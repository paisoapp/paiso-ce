import { create } from "zustand";
import { persist } from "zustand/middleware";
import { setAccessToken, setTokenRefreshedHandler } from "@/lib/api";
import { queryClient } from "@/lib/queryClient";
import { useUiPrefsStore } from "@/store/uiPrefs";

interface AuthState {
  accessToken: string | null;
  isAuthenticated: boolean;
  setToken: (token: string) => void;
  replaceToken: (token: string) => void;
  clearToken: () => void;
}

/** Where the signed-in hint is kept. Other tabs watch this key to follow a sign-out. */
export const AUTH_STORAGE_KEY = "paiso-auth";

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      isAuthenticated: false,
      setToken: (token) => {
        setAccessToken(token);
        // A new sign-in may be a *different* user than the one whose data is
        // cached in-memory — drop it so nothing leaks across accounts.
        queryClient.clear();
        // Onboarding progress is per-account but cached in a browser-shared
        // localStorage key; clear it so a new signup doesn't inherit the prior
        // account's completed steps (re-hydrated from the server after login).
        useUiPrefsStore.getState().resetForNewSession();
        set({ accessToken: token, isAuthenticated: true });
      },
      // The same person carrying on with a new token (after a password
      // change, or signing out other devices). Nothing cached belongs to
      // anyone else, so it stays, and the page they are on does not reset.
      replaceToken: (token) => {
        setAccessToken(token);
        set({ accessToken: token, isAuthenticated: true });
      },
      clearToken: () => {
        setAccessToken(null);
        // Signing out: purge cached account data so the next user starts clean.
        queryClient.clear();
        useUiPrefsStore.getState().resetForNewSession();
        set({ accessToken: null, isAuthenticated: false });
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      // Only the "was signed in" hint is stored. The access token stays in
      // memory, where a script injected into the page cannot lift it from
      // storage and use it elsewhere. After a reload the app redeems
      // the httpOnly refresh cookie for a new one: see restoreSession().
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated }),
      // Version 0 stored the token itself. Reading the saved state through
      // this drops it, and the next write removes it from storage.
      version: 1,
      migrate: (saved) => ({
        isAuthenticated: Boolean((saved as { isAuthenticated?: boolean } | null)?.isAuthenticated),
      }),
    },
  ),
);

// Keep the store in step with a silently refreshed token without clearing
// cached data: it is the same user continuing their session.
setTokenRefreshedHandler((token) => {
  useAuthStore.setState({ accessToken: token, isAuthenticated: true });
});

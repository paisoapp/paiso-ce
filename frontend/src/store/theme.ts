import { create } from "zustand";
import { api, getAccessToken } from "@/lib/api";
import { resolveThemeId, type ThemeId } from "@/lib/themes";

// Theming has two independent axes (see src/index.css):
//   • themeId → data-theme="<id>" attribute
//   • mode    → .dark / .gray class (light = neither)
// State is shared module-wide via this store so the Sidebar quick-toggle and the
// Settings picker never diverge.
//
// Appearance is a *per-device* preference: a phone used at night and a desktop
// used in daylight legitimately want different modes, and syncing them meant
// picking dark on one device silently flipped the other. localStorage is
// therefore authoritative once this device has made a choice. The backend copy
// is still written on every change and is still read — but only to seed a device
// that has never chosen, so a new install starts on your usual look instead of
// the OS default. [issue 13]

// "system" is a stored choice like any other, resolved against the OS at paint
// time. Before it existed, a device that had never chosen took a one-time
// snapshot of the OS preference at load and then stayed there — so the app
// disagreed with the OS the moment it flipped, and there was no way to ask for
// "follow the OS" once you had picked anything. [issue 210]
export type Mode = "light" | "dark" | "gray" | "system";
const MODES: Mode[] = ["light", "dark", "gray", "system"];

/** What "system" currently means. */
function osMode(): "light" | "dark" {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The look actually painted — the CSS knows nothing about "system". */
function resolveMode(mode: Mode): "light" | "dark" | "gray" {
  return mode === "system" ? osMode() : mode;
}

const LS_MODE = "paiso-theme";
const LS_VARIANT = "paiso-theme-variant";

/**
 * Whether this device had already chosen each axis, captured once at module
 * load — before any setter can write to localStorage. Read lazily afterwards
 * and it would always say "yes", which would make the server seed dead code.
 */
function hasStored(key: string): boolean {
  try {
    return localStorage.getItem(key) != null;
  } catch {
    return false;
  }
}

// Not `const`: a choice made *during* this session counts too. These began as
// a load-time snapshot, which was harmless while the only way to change the
// look was from inside the app — hydration has already run by then. The login
// screen's toggle opened the gap: pick System there, sign in, and the server's
// stored value would overwrite the pick you had just made. [issue 210]
/**
 * A link from the marketing site (paisoapp.com) carries the mode the visitor
 * picked there as `?theme=light|dark|gray`. The two sites are separate
 * origins and cannot share storage, so the link is how the choice crosses.
 * It is adopted as this device's choice before anything below reads the
 * stored mode, and wiped from the address bar. A link with no `theme` (the
 * visitor never picked one there) leaves the app following the system, as
 * the marketing site did.
 */
function adoptModeFromLink(): void {
  try {
    const url = new URL(window.location.href);
    const asked = url.searchParams.get("theme");
    if (asked === null) return;
    url.searchParams.delete("theme");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (asked === "light" || asked === "dark" || asked === "gray") localStorage.setItem(LS_MODE, asked);
  } catch {
    /* storage blocked: the page keeps its own default */
  }
}
adoptModeFromLink();

let deviceChoseMode = hasStored(LS_MODE);
let deviceChoseVariant = hasStored(LS_VARIANT);

function readMode(): Mode {
  try {
    const stored = localStorage.getItem(LS_MODE) as Mode | null;
    if (stored && MODES.includes(stored)) return stored;
  } catch {
    /* ignore */
  }
  // Nothing chosen on this device — follow the OS, and keep following it.
  return "system";
}

function readVariant(): ThemeId {
  try {
    return resolveThemeId(localStorage.getItem(LS_VARIANT));
  } catch {
    return resolveThemeId(null);
  }
}

function apply(themeId: ThemeId, mode: Mode) {
  const root = document.documentElement;
  const painted = resolveMode(mode);
  root.dataset.theme = themeId;
  root.classList.toggle("dark", painted === "dark");
  root.classList.toggle("gray", painted === "gray");
}

function persistServer(themeId: ThemeId, mode: Mode) {
  // Signed out there is no profile to save to, and the 401 that came back
  // reached the app's unauthorized handler, which sent the visitor to /login:
  // changing the look on the sign-up page left the sign-up page. The device
  // copy in localStorage still keeps the choice.
  if (!getAccessToken()) return;
  // Fire-and-forget; ignore failures.
  api.patch("/settings/profile", { theme: mode, theme_variant: themeId }).catch(() => {});
}

/** A mode the CSS understands — "system" already resolved. */
type PaintedMode = "light" | "dark" | "gray";

interface ThemeState {
  themeId: ThemeId;
  /** What the user chose, which may be "system". */
  mode: Mode;
  /** What is actually on screen. Kept in state, not derived at each call site,
   *  so a component reading it re-renders when the OS flips under "system". */
  resolved: PaintedMode;
  setTheme: (id: ThemeId) => void;
  setMode: (m: Mode) => void;
  cycle: () => void;
  /**
   * Seed axes this device has never chosen from the backend. Axes the device
   * *has* chosen are left alone — appearance is per-device.
   */
  hydrateFromServer: (theme?: string | null, variant?: string | null) => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  themeId: readVariant(),
  mode: readMode(),
  resolved: resolveMode(readMode()),

  setTheme: (id) => {
    const themeId = resolveThemeId(id);
    const { mode } = get();
    deviceChoseVariant = true;
    apply(themeId, mode);
    try {
      localStorage.setItem(LS_VARIANT, themeId);
    } catch {
      /* ignore */
    }
    persistServer(themeId, mode);
    set({ themeId });
  },

  setMode: (mode) => {
    const { themeId } = get();
    deviceChoseMode = true;
    apply(themeId, mode);
    try {
      localStorage.setItem(LS_MODE, mode);
    } catch {
      /* ignore */
    }
    persistServer(themeId, mode);
    set({ mode, resolved: resolveMode(mode) });
  },

  cycle: () => {
    const next = MODES[(MODES.indexOf(get().mode) + 1) % MODES.length];
    get().setMode(next);
  },

  hydrateFromServer: (theme, variant) => {
    // Only fill in what this device never picked. Without the guard, the server
    // value would overwrite the local choice on every login and the two devices
    // would keep fighting over one setting.
    const serverMode =
      !deviceChoseMode && theme && MODES.includes(theme as Mode) ? (theme as Mode) : null;
    const serverVariant = !deviceChoseVariant && variant ? resolveThemeId(variant) : null;

    const themeId = serverVariant ?? get().themeId;
    const mode = serverMode ?? get().mode;
    if (themeId === get().themeId && mode === get().mode) return;

    apply(themeId, mode);
    try {
      // Adopting the seed counts as this device's choice from here on.
      if (serverVariant) localStorage.setItem(LS_VARIANT, themeId);
      if (serverMode) localStorage.setItem(LS_MODE, mode);
    } catch {
      /* ignore */
    }
    set({ themeId, mode, resolved: resolveMode(mode) });
  },
}));

/** Whether charts and other palettes should use their dark variant.
 *
 *  Reads the resolved mode: comparing `mode !== "light"` at the call site was
 *  correct until "system" existed, at which point a system-light device would
 *  have got dark charts. */
export function useIsDarkMode(): boolean {
  return useThemeStore((s) => s.resolved) !== "light";
}

// Apply persisted values immediately on module load so axes match the inline
// no-flash script even before any component mounts.
apply(useThemeStore.getState().themeId, useThemeStore.getState().mode);

// Repaint when the OS flips, but only while the user is actually on "system".
try {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const { themeId, mode } = useThemeStore.getState();
      if (mode !== "system") return;
      apply(themeId, mode);
      useThemeStore.setState({ resolved: resolveMode(mode) });
    });
} catch {
  /* Old Safari / jsdom: no listener, so "system" just stops tracking live. */
}

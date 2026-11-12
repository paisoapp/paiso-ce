import { create } from "zustand";
import { api } from "@/lib/api";
import {
  type DateRange,
  defaultRange,
  getPresetLabel,
  resolvePresetLabel,
} from "@/components/ui/DateRangePicker";

// Cross-device UI preferences. Two persistence layers, mirroring the theme store:
//   • localStorage → instant, flash-free reads on first paint, works offline
//   • backend (UserSettings.ui_prefs) → follows the user across devices
// Selections are cached locally and pushed to the server fire-and-forget; the
// server value is adopted once per session via hydrateFromServer.

// A remembered date-range selection. Presets are stored by label so they stay
// current (e.g. "This month" recomputes each session rather than freezing on the
// month it was picked); custom ranges keep their absolute dates.
export type StoredRange =
  | { kind: "all" }
  | { kind: "preset"; label: string }
  | { kind: "custom"; from: string; to: string };

// The parts of the app that each keep their own date range. A range picked on
// Budgeting says nothing about how far back someone wants their portfolio
// chart to reach, so one shared setting would have each page undoing the last.
export type DateRangeSection =
  | "budgeting"
  | "transactions"
  // Stocks & Funds keeps the original key, so a range picked there before
  // each Investments tab had its own is still remembered.
  | "investments"
  | "investments_overview"
  | "investments_retirement"
  | "investments_education"
  | "investments_health"
  | "portfolio"
  | "dashboard";

// Onboarding progress. Drives the signup wizard + one-time contextual feature
// tips. Persisted alongside the other UI prefs so it follows the user across
// devices (a step finished on desktop shows as done on mobile).
export type OnboardingStatus = "unstarted" | "active" | "dismissed" | "completed";

/** What the user told the wizard about themselves. Drives the plan
 *  recommendation and the order of the setup guide. Nothing here is
 *  account-level detail: it is what they came for and what kinds of things
 *  they have. */
export interface OnboardingAnswers {
  /** What they want to do first. */
  goals: string[];
  /** How they manage their finances today. */
  manage?: string | null;
  /** Which kinds of accounts and assets they have. */
  have?: string[];
}

export interface OnboardingState {
  status: OnboardingStatus;
  /** Resume position into the wizard steps (0-based). */
  currentStep: number;
  /** Step ids the user explicitly finished or skipped. */
  completedSteps: string[];
  /** Docked guide panel collapsed to a bubble. */
  guideMinimized: boolean;
  /** Ids of contextual feature tips already shown + dismissed. */
  seenTips: string[];
  answers?: OnboardingAnswers;
}

const DEFAULT_ONBOARDING: OnboardingState = {
  status: "unstarted",
  currentStep: 0,
  completedSteps: [],
  guideMinimized: false,
  seenTips: [],
};

// The user's own Dashboard: which widgets, in what order, at what size.
// `null` means "the default layout" — kept distinct from an empty list so a
// user who removed every widget is not silently handed the defaults back, and
// so a change to the default reaches everyone who never customised.
export type DashboardWidgetSize = "sm" | "md" | "lg";

export interface DashboardWidgetPlacement {
  id: string;
  size: DashboardWidgetSize;
}

export interface DashboardLayout {
  version: 1;
  widgets: DashboardWidgetPlacement[];
}

// Which of the two Investment Performance headline figures is the big one:
// the portfolio's absolute value, or its change over the selected range.
export type HeadlineFocus = "value" | "change";

// Remembered table sort, keyed by table id (e.g. "holdings", "transactions").
// A sort is a reading preference — someone who works from "best day gain"
// wants that order the next time they open the page, not the default.
export interface TableSort {
  key: string;
  dir: "asc" | "desc";
}

/** Convert a picker value → the persistable form. */
export function rangeToStored(r: DateRange | null): StoredRange {
  if (r === null) return { kind: "all" };
  const label = getPresetLabel(r);
  return label ? { kind: "preset", label } : { kind: "custom", from: r.from, to: r.to };
}

/** Convert a persisted selection → a picker value (recomputing presets). */
export function storedToRange(s: StoredRange): DateRange | null {
  if (s.kind === "all") return null;
  if (s.kind === "custom") return { from: s.from, to: s.to };
  // A label this build no longer offers falls back to the default.
  return resolvePresetLabel(s.label) ?? defaultRange();
}

interface Persisted {
  sidebarCollapsed: boolean;
  /** The range each section was last left on. A section with no entry is on
   *  the default (see `defaultRange`), which is kept distinct from a stored
   *  "Last 3 months" so a change to the default reaches everyone who never
   *  chose. Replaces `investmentsRange`, which could not tell the two apart:
   *  it was always written, default or not. */
  dateRanges: Partial<Record<DateRangeSection, StoredRange>>;
  /** Route the app navigates to on login and on relaunch, e.g. "/portfolio". */
  defaultLandingPage: string;
  onboarding: OnboardingState;
  dashboardLayout: DashboardLayout | null;
  /** Portfolio → Account Details section ids in the user's order; `null`
   *  is the default order. */
  portfolioSectionOrder: string[] | null;
  /** Which figure the Investment Performance headline emphasises. */
  investmentsHeadlineFocus: HeadlineFocus;
  /** Remembered sort per table id. */
  tableSort: Record<string, TableSort>;
  /** How wide the side drawer opens, as a share of the window (0.4 = 40%).
   *  One value for every drawer in the app. `null` is the default, kept
   *  distinct so a change to the default reaches everyone who never dragged. */
  drawerWidth: number | null;
  /** Holdings-table rows the user hid (their `row_key`s). Hidden rows still
   *  count toward every total; this only takes them out of the table. */
  hiddenHoldingRows: string[];
  /** Investments → Overview: purpose sections in the user's order (`null` is
   *  the default order) and the ones they collapsed. */
  investmentsSectionOrder: string[] | null;
  investmentsCollapsed: string[];
  /** The tab each section opens on, keyed by section ("investments" →
   *  "stocks"). A section with no entry opens on its first tab. */
  pinnedTabs: Record<string, string>;
}

const DEFAULT_LANDING_PAGE = "/";

const LS_KEY = "paiso-ui-prefs";

/** A fresh browser's preferences, and a new account's (see hydrateFromServer). */
function defaultPrefs(): Persisted {
  return {
    sidebarCollapsed: false,
    dateRanges: {},
    defaultLandingPage: DEFAULT_LANDING_PAGE,
    onboarding: DEFAULT_ONBOARDING,
    dashboardLayout: null,
    portfolioSectionOrder: null,
    investmentsHeadlineFocus: "change",
    tableSort: {},
    drawerWidth: null,
    hiddenHoldingRows: [],
    investmentsSectionOrder: null,
    investmentsCollapsed: [],
    pinnedTabs: {},
  };
}

function readLocal(): Persisted {
  const fallback = defaultPrefs();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      sidebarCollapsed: parsed.sidebarCollapsed ?? fallback.sidebarCollapsed,
      dateRanges: parsed.dateRanges ?? fallback.dateRanges,
      defaultLandingPage: upgradeLandingPage(parsed.defaultLandingPage ?? fallback.defaultLandingPage),
      onboarding: { ...DEFAULT_ONBOARDING, ...(parsed.onboarding ?? {}) },
      dashboardLayout: parsed.dashboardLayout ?? null,
      portfolioSectionOrder: parsed.portfolioSectionOrder ?? null,
      investmentsHeadlineFocus: parsed.investmentsHeadlineFocus ?? fallback.investmentsHeadlineFocus,
      tableSort: parsed.tableSort ?? fallback.tableSort,
      drawerWidth: typeof parsed.drawerWidth === "number" ? parsed.drawerWidth : null,
      hiddenHoldingRows: parsed.hiddenHoldingRows ?? [],
      investmentsSectionOrder: parsed.investmentsSectionOrder ?? null,
      investmentsCollapsed: parsed.investmentsCollapsed ?? [],
      pinnedTabs: upgradePinnedTabs(parsed.pinnedTabs ?? {}),
    };
  } catch {
    return fallback;
  }
}

/** The Budgeting section became Cash Flow. Its URL moved from
 *  /budgeting to /cashflow, its Cash Flow tab is now Overview and its
 *  Performance tab is now Budget. Preferences saved before then still name
 *  the old ones, so they are read through these. The pin keeps its
 *  "budgeting" key, like the section's date range. */
const RENAMED_CASHFLOW_TABS: Record<string, string> = { cashflow: "overview", performance: "budget" };

function upgradeLandingPage(page: string): string {
  return page === "/budgeting" ? "/cashflow" : page;
}

function upgradePinnedTabs(tabs: Record<string, string>): Record<string, string> {
  const renamed = RENAMED_CASHFLOW_TABS[tabs.budgeting];
  return renamed ? { ...tabs, budgeting: renamed } : tabs;
}

function writeLocal(p: Persisted) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

// One save in flight at a time, always of the newest state. Each save sends
// the whole blob, so two fired back to back could land in either order and
// leave the server holding the older one: the next sign-in then restored
// state the user had already moved past. The setup wizard, which saves on
// every step, is where that showed.
let queued: Persisted | null = null;
let saving = false;

async function drainSaves() {
  if (saving) return;
  saving = true;
  try {
    while (queued) {
      const next = queued;
      queued = null;
      // Ignore failures (not authenticated yet, offline, …).
      await api.patch("/settings/profile", { ui_prefs: next }).catch(() => {});
    }
  } finally {
    saving = false;
  }
}

function persistServer(p: Persisted) {
  // Until this session has read the server's copy, the onboarding held here
  // is a placeholder (sign-in resets it to the defaults). Saving it would put
  // the account back to "unstarted" with no tips seen, so leave it out; the
  // server merges the keys it is sent and keeps the rest.
  if (!useUiPrefsStore.getState().hydratedForSession) {
    const { onboarding: _placeholder, ...rest } = p;
    queued = rest as Persisted;
  } else {
    queued = p;
  }
  void drainSaves();
}

interface UiPrefsState extends Persisted {
  /** True once this session has adopted the server value for the current
   *  account. Reset on every sign-in so a new account re-hydrates. */
  hydratedForSession: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  /** Remember the range a section was left on. */
  setSectionDateRange: (section: DateRangeSection, r: StoredRange) => void;
  setDefaultLandingPage: (path: string) => void;
  /** Shallow-merge a patch into the onboarding blob. */
  setOnboarding: (patch: Partial<OnboardingState>) => void;
  /** `null` restores the default layout. */
  setDashboardLayout: (layout: DashboardLayout | null) => void;
  /** `null` restores the default order. */
  setPortfolioSectionOrder: (order: string[] | null) => void;
  setInvestmentsHeadlineFocus: (focus: HeadlineFocus) => void;
  /** Remember (or, with `null`, forget) how one table is sorted. */
  setTableSort: (tableId: string, sort: TableSort | null) => void;
  /** Remember the drawer width as a share of the window; `null` restores the default. */
  setDrawerWidth: (share: number | null) => void;
  /** Hide (or, with `hidden: false`, show again) one Holdings-table row. */
  setHoldingRowHidden: (rowKey: string, hidden: boolean) => void;
  /** `null` restores the default order. */
  setInvestmentsSectionOrder: (order: string[] | null) => void;
  setInvestmentsCollapsed: (ids: string[]) => void;
  /** Open `section` on `tab` from now on; `null` goes back to the first tab. */
  setPinnedTab: (section: string, tab: string | null) => void;
  markHydrated: () => void;
  /** New sign-in / sign-out: onboarding is per-account but the localStorage
   *  cache is shared across accounts on this browser, so clear it and force a
   *  re-hydrate. Prevents a new account inheriting a prior account's progress. */
  resetForNewSession: () => void;
  /** Adopt cross-device values fetched from the backend, if they differ. */
  hydrateFromServer: (prefs?: Partial<Persisted> | null) => void;
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  ...readLocal(),
  hydratedForSession: false,

  setSidebarCollapsed: (sidebarCollapsed) => {
    const next: Persisted = { ...persistedOf(get()), sidebarCollapsed };
    writeLocal(next);
    persistServer(next);
    set({ sidebarCollapsed });
  },

  setSectionDateRange: (section, r) => {
    const dateRanges = { ...get().dateRanges, [section]: r };
    const next: Persisted = { ...persistedOf(get()), dateRanges };
    writeLocal(next);
    persistServer(next);
    set({ dateRanges });
  },

  setDefaultLandingPage: (defaultLandingPage) => {
    const next: Persisted = { ...persistedOf(get()), defaultLandingPage };
    writeLocal(next);
    persistServer(next);
    set({ defaultLandingPage });
  },

  setOnboarding: (patch) => {
    const onboarding = { ...get().onboarding, ...patch };
    const next: Persisted = { ...persistedOf(get()), onboarding };
    writeLocal(next);
    persistServer(next);
    set({ onboarding });
  },

  setDashboardLayout: (dashboardLayout) => {
    const next: Persisted = { ...persistedOf(get()), dashboardLayout };
    writeLocal(next);
    persistServer(next);
    set({ dashboardLayout });
  },

  setPortfolioSectionOrder: (portfolioSectionOrder) => {
    const next: Persisted = { ...persistedOf(get()), portfolioSectionOrder };
    writeLocal(next);
    persistServer(next);
    set({ portfolioSectionOrder });
  },

  setInvestmentsHeadlineFocus: (investmentsHeadlineFocus) => {
    const next: Persisted = { ...persistedOf(get()), investmentsHeadlineFocus };
    writeLocal(next);
    persistServer(next);
    set({ investmentsHeadlineFocus });
  },

  setTableSort: (tableId, sort) => {
    const tableSort = { ...get().tableSort };
    if (sort) tableSort[tableId] = sort;
    else delete tableSort[tableId];
    const next: Persisted = { ...persistedOf(get()), tableSort };
    writeLocal(next);
    persistServer(next);
    set({ tableSort });
  },

  setDrawerWidth: (drawerWidth) => {
    const next: Persisted = { ...persistedOf(get()), drawerWidth };
    writeLocal(next);
    persistServer(next);
    set({ drawerWidth });
  },

  setHoldingRowHidden: (rowKey, hidden) => {
    const rest = get().hiddenHoldingRows.filter((k) => k !== rowKey);
    const hiddenHoldingRows = hidden ? [...rest, rowKey] : rest;
    const next: Persisted = { ...persistedOf(get()), hiddenHoldingRows };
    writeLocal(next);
    persistServer(next);
    set({ hiddenHoldingRows });
  },

  setInvestmentsSectionOrder: (investmentsSectionOrder) => {
    const next: Persisted = { ...persistedOf(get()), investmentsSectionOrder };
    writeLocal(next);
    persistServer(next);
    set({ investmentsSectionOrder });
  },

  setInvestmentsCollapsed: (investmentsCollapsed) => {
    const next: Persisted = { ...persistedOf(get()), investmentsCollapsed };
    writeLocal(next);
    persistServer(next);
    set({ investmentsCollapsed });
  },

  setPinnedTab: (section, tab) => {
    const pinnedTabs = { ...get().pinnedTabs };
    if (tab) pinnedTabs[section] = tab;
    else delete pinnedTabs[section];
    const next: Persisted = { ...persistedOf(get()), pinnedTabs };
    writeLocal(next);
    persistServer(next);
    set({ pinnedTabs });
  },

  markHydrated: () => set({ hydratedForSession: true }),

  resetForNewSession: () => {
    // The dashboard layout and portfolio order are per-account too, for the
    // same reason.
    const next: Persisted = {
      ...persistedOf(get()),
      onboarding: DEFAULT_ONBOARDING,
      dashboardLayout: null,
      portfolioSectionOrder: null,
      hiddenHoldingRows: [],
      investmentsSectionOrder: null,
      investmentsCollapsed: [],
      pinnedTabs: {},
    };
    writeLocal(next); // local only — don't push DEFAULT to the server
    set({
      onboarding: DEFAULT_ONBOARDING,
      dashboardLayout: null,
      portfolioSectionOrder: null,
      hiddenHoldingRows: [],
      investmentsSectionOrder: null,
      investmentsCollapsed: [],
      pinnedTabs: {},
      hydratedForSession: false,
    });
  },

  hydrateFromServer: (prefs) => {
    if (!prefs) return;
    // An account that has never saved a preference (the server answers {})
    // starts from the defaults. Falling back to this browser's values gave a
    // new account the last account's collapsed sidebar, date ranges and
    // landing page when both were used on one browser.
    const isNewAccount = Object.keys(prefs).length === 0;
    const held = persistedOf(get());
    const current = isNewAccount ? defaultPrefs() : held;
    const next: Persisted = {
      sidebarCollapsed: prefs.sidebarCollapsed ?? current.sidebarCollapsed,
      dateRanges: prefs.dateRanges ?? current.dateRanges,
      defaultLandingPage: upgradeLandingPage(prefs.defaultLandingPage ?? current.defaultLandingPage),
      // Onboarding is per-account, but the local cache is shared across any
      // accounts used on this browser. Treat the server as authoritative: if the
      // freshly-fetched profile has no onboarding, this is a new/never-onboarded
      // account, so start fresh rather than inherit the prior account's status.
      // A tip dismissed here before the fetch landed stays dismissed: seen
      // tips only ever grow (the server keeps them the same way).
      onboarding: prefs.onboarding
        ? {
            ...DEFAULT_ONBOARDING,
            ...prefs.onboarding,
            seenTips: [...new Set([...(prefs.onboarding.seenTips ?? []), ...held.onboarding.seenTips])],
          }
        : DEFAULT_ONBOARDING,
      // Per-account like onboarding: the server is authoritative, and an
      // account that never customised gets the default, not this browser's
      // previous account's layout.
      dashboardLayout: prefs.dashboardLayout ?? null,
      portfolioSectionOrder: prefs.portfolioSectionOrder ?? null,
      investmentsHeadlineFocus: prefs.investmentsHeadlineFocus ?? current.investmentsHeadlineFocus,
      tableSort: prefs.tableSort ?? current.tableSort,
      drawerWidth: typeof prefs.drawerWidth === "number" ? prefs.drawerWidth : current.drawerWidth,
      // Per-account, server authoritative, like the portfolio order.
      hiddenHoldingRows: prefs.hiddenHoldingRows ?? [],
      investmentsSectionOrder: prefs.investmentsSectionOrder ?? null,
      investmentsCollapsed: prefs.investmentsCollapsed ?? [],
      // Per-account, server authoritative.
      pinnedTabs: upgradePinnedTabs(prefs.pinnedTabs ?? {}),
    };
    if (JSON.stringify(next) === JSON.stringify(held)) return;
    writeLocal(next);
    set(next);
  },
}));

function persistedOf(s: UiPrefsState): Persisted {
  return {
    sidebarCollapsed: s.sidebarCollapsed,
    dateRanges: s.dateRanges,
    defaultLandingPage: s.defaultLandingPage,
    onboarding: s.onboarding,
    dashboardLayout: s.dashboardLayout,
    portfolioSectionOrder: s.portfolioSectionOrder,
    investmentsHeadlineFocus: s.investmentsHeadlineFocus,
    tableSort: s.tableSort,
    drawerWidth: s.drawerWidth,
    hiddenHoldingRows: s.hiddenHoldingRows,
    investmentsSectionOrder: s.investmentsSectionOrder,
    investmentsCollapsed: s.investmentsCollapsed,
    pinnedTabs: s.pinnedTabs,
  };
}

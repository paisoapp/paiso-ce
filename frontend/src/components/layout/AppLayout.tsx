import { Disclaimer } from "@/components/ui/Disclaimer";
import { useState, useEffect } from "react";
import { Outlet, Link, useLocation, useNavigate } from "react-router-dom";
import { PaisoMark, Wordmark } from "@/components/brand/PaisoLogo";
import { Sidebar } from "./Sidebar";
import { BottomNav } from "./BottomNav";
import { useAuthStore } from "@/store/auth";
import { useMe, avatarInitial } from "@/hooks/useMe";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { useHydrateUiPrefs } from "@/hooks/useUiPrefs";
import { OnboardingController } from "@/components/onboarding/OnboardingController";
import { PrivacyBlur } from "./PrivacyBlur";
import { NAV_ITEMS } from "@/lib/navRoutes";
import { usePageTitle } from "@/lib/pageTitle";

// Module-level (not component state) so a hard refresh/app relaunch resets it
// (fresh JS module load) but in-app navigation back to "/" — e.g. clicking
// "Dashboard" in the sidebar — doesn't re-trigger the redirect.
let hasAppliedLandingRedirect = false;

export function AppLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: me, isLoading: meLoading } = useMe();
  const initial = avatarInitial(me);
  // Sidebar collapsed state is a remembered UI preference (localStorage + backend).
  const collapsed = useUiPrefsStore((s) => s.sidebarCollapsed);
  const setCollapsed = useUiPrefsStore((s) => s.setSidebarCollapsed);
  const defaultLandingPage = useUiPrefsStore((s) => s.defaultLandingPage);
  const [mobileOpen, setMobileOpen] = useState(false);

  // The section's name for the browser tab; its tabs add their own.
  const section =
    pathname.startsWith("/settings") ? "Settings"
    : NAV_ITEMS.find((i) => (i.to === "/" ? pathname === "/" : pathname === i.to || pathname.startsWith(i.to + "/")))?.label;
  usePageTitle("section", section);

  // Adopt cross-device UI prefs (sidebar state, remembered date ranges, default
  // landing page) on login.
  const { ready: prefsReady } = useHydrateUiPrefs();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/login", { replace: true });
      hasAppliedLandingRedirect = false; // let a later login (same tab) re-apply
    }
  }, [isAuthenticated, navigate]);

  // Land on the user's chosen default page — covers both "just logged in"
  // (LoginPage always navigates to "/") and "relaunched the app" (a fresh
  // page load resets the module-level flag). Waits for prefsReady so a
  // cross-device default isn't missed by racing the fetch. Only fires once
  // per app load and only from "/", so clicking "Dashboard" in the sidebar
  // afterwards behaves normally.
  useEffect(() => {
    if (!isAuthenticated || !prefsReady || !me || hasAppliedLandingRedirect) return;
    hasAppliedLandingRedirect = true;
    // A saved landing page that is no longer a section stays on the dashboard.
    const allowed = NAV_ITEMS.some((i) => i.to === defaultLandingPage);
    if (pathname === "/" && defaultLandingPage && defaultLandingPage !== "/" && allowed) {
      navigate(defaultLandingPage, { replace: true });
    }
  }, [isAuthenticated, prefsReady, me, pathname, defaultLandingPage, navigate]);

  // Close the drawer when navigating to a new page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  if (!isAuthenticated) return null;
  // Nothing renders until /auth/me answers, so pages see the resolved flags.
  if (meLoading) return null;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex shrink-0">
        <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      </div>

      {/* Mobile drawer — opens from the right to match the bottom "More" tab */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="flex-1 bg-black/40"
            onClick={() => setMobileOpen(false)}
          />
          <div className="w-72 max-w-[85vw] shrink-0 overflow-y-auto">
            <Sidebar
              collapsed={false}
              onToggle={() => setMobileOpen(false)}
              mobile
              className="w-full border-r-0 border-l"
            />
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        {/* Mobile top bar — branding left, profile avatar right. The nav drawer opens from the bottom "More" tab. */}
        <header className="lg:hidden flex items-center gap-2 px-4 h-14 border-b border-border bg-card shrink-0">
          <PaisoMark className="h-9 w-9 shrink-0" />
          <Wordmark className="text-lg" />
          <Link
            to="/settings?tab=account"
            aria-label="My account"
            className="ml-auto flex items-center justify-center rounded-full -mr-1 p-1 hover:bg-accent transition-colors"
          >
            {me?.avatar ? (
              <img src={me.avatar} alt="" className="h-8 w-8 rounded-full object-cover" />
            ) : (
              <div className="h-8 w-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">
                {initial}
              </div>
            )}
          </Link>
        </header>

        {/* Onboarding: sends new accounts to the wizard, and shows the setup
            strip in its own row, where it covers nothing. */}
        <OnboardingController />
        <PrivacyBlur />
        <main className="flex-1 overflow-y-auto p-4 pb-24 lg:p-6">
          {/* The column is at least as tall as the view, so on a short page
              the disclaimer sits at the bottom of the window and not halfway
              up it; on a long one it follows the content. */}
          <div className="flex min-h-full flex-col">
            <div className="flex-1">
              <Outlet />
            </div>
            <footer className="mt-10 pt-4">
              <Disclaimer kind="general" className="text-center text-muted-foreground/60" />
            </footer>
          </div>
        </main>
      </div>

      <BottomNav onMore={() => setMobileOpen(true)} />
    </div>
  );
}

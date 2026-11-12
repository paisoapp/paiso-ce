import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { AppLayout } from "@/components/layout/AppLayout";
import { AppErrorBoundary } from "@/components/layout/AppErrorBoundary";
import { LoginPage } from "@/pages/Auth/LoginPage";
import { RegisterPage } from "@/pages/Auth/RegisterPage";
import { NotFoundPage } from "@/pages/NotFound/NotFoundPage";
import { ForgotPasswordPage } from "@/pages/Auth/ForgotPasswordPage";
import { WizardPage } from "@/pages/Onboarding/WizardPage";
import { ForcePasswordChangePage } from "@/pages/Auth/ForcePasswordChangePage";
import { ForceMfaPage } from "@/pages/Auth/ForceMfaPage";
import {
  setUnauthorizedHandler, setForcedActionHandler,
  restoreSession,
} from "@/lib/api";
import { AUTH_STORAGE_KEY, useAuthStore } from "@/store/auth";
import { Toaster } from "@/components/ui/toast";
import { AppTooltips } from "@/components/ui/AppTooltips";
import { cashFlowPathFromLegacy } from "@/lib/navTargets";

const DashboardPage = lazy(() => import("@/pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const PortfolioPage = lazy(() => import("@/pages/Portfolio").then((m) => ({ default: m.PortfolioPage })));
const InvestmentsPage = lazy(() => import("@/pages/Investments").then((m) => ({ default: m.InvestmentsPage })));
const BudgetingPage = lazy(() => import("@/pages/Budgeting").then((m) => ({ default: m.BudgetingPage })));
const TransactionsPage = lazy(() => import("@/pages/Transactions").then((m) => ({ default: m.TransactionsPage })));
const SettingsPage = lazy(() => import("@/pages/Settings").then((m) => ({ default: m.SettingsPage })));

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-32">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}

/** Old /budgeting links (bookmarks, help articles, emails) to their place in
 *  Cash Flow, keeping any query and hash. */
function LegacyBudgetingRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={cashFlowPathFromLegacy(pathname) + search + hash} replace />;
}

/** Pages a signed-out visitor sits on. A tab left on one of these follows a
 *  sign-in made in another tab. */
const SIGNED_OUT_PATHS = new Set(["/login", "/register", "/forgot-password"]);
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

function AuthHandler() {
  const navigate = useNavigate();
  const clearToken = useAuthStore((s) => s.clearToken);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearToken();
      navigate("/login", { replace: true });
    });
    setForcedActionHandler((action) => {
      navigate(action === "password" ? "/force-password-change" : "/force-mfa", { replace: true });
    });
  }, [navigate, clearToken]);

  // Signing out in one tab signs out the others, and signing in signs them in. Each tab holds its own
  // access token in memory, which stays valid for up to an hour, so without
  // this a second tab carried on working after the first had signed out.
  // The browser tells every other tab when the stored signed-in hint changes.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== AUTH_STORAGE_KEY) return;
      let signedIn = false;
      try {
        signedIn = Boolean(JSON.parse(e.newValue ?? "null")?.state?.isAuthenticated);
      } catch {
        // Unreadable or cleared storage counts as signed out.
      }
      const here = useAuthStore.getState().isAuthenticated;
      if (!signedIn && here) {
        clearToken();
        navigate("/login", { replace: true });
      } else if (signedIn && !here) {
        // Another tab signed in. Pick the session up from the refresh cookie
        // (the token handler marks this tab signed in) and leave the sign-in
        // page, so nobody is asked to sign in twice.
        void restoreSession().then((ok) => {
          if (ok && SIGNED_OUT_PATHS.has(window.location.pathname.replace(BASE_PATH, "") || "/")) {
            navigate("/", { replace: true });
          }
        });
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [navigate, clearToken]);
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthHandler />
        <AppErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            {/* The setup guide, where sign-up lands. */}
            <Route path="/welcome" element={<WizardPage />} />
            {/* Forced-action screens live outside AppLayout so the rest of the
                app (which would 403 on every call) never renders around them. */}
            <Route path="/force-password-change" element={<ForcePasswordChangePage />} />
            <Route path="/force-mfa" element={<ForceMfaPage />} />
            <Route element={<AppLayout />}>
              <Route index element={<DashboardPage />} />
              <Route path="portfolio" element={<PortfolioPage />} />
              <Route
                path="investments/*"
                element={<InvestmentsPage />}
              />
              <Route
                path="cashflow/*"
                element={<BudgetingPage />}
              />
              <Route path="budgeting/*" element={<LegacyBudgetingRedirect />} />
              <Route path="transactions/*" element={<TransactionsPage />} />
              <Route path="settings/*" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
        </AppErrorBoundary>
        <Toaster />
        {/* Every hover tip in the app's own style, not the browser's. */}
        <AppTooltips />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

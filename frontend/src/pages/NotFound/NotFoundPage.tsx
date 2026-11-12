import { Link, useLocation } from "react-router-dom";
import { PaisoMark } from "@/components/brand/PaisoLogo";
import { useAuthStore } from "@/store/auth";
import { usePageTitle } from "@/lib/pageTitle";

/**
 * An address that is not a page. It used to redirect to the dashboard, which
 * sent a signed-out visitor to the sign-in form with no word about the link
 * they followed. It now says so, and offers the way back that fits
 * whether they are signed in.
 */
export function NotFoundPage() {
  usePageTitle("section", "Page not found");
  const { pathname } = useLocation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background px-4 text-center">
      <PaisoMark className="h-16 w-16" />
      <div className="max-w-sm space-y-2">
        <p className="text-sm font-medium text-muted-foreground">404</p>
        <h1 className="text-2xl font-bold">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          There is no page at <span className="font-mono text-foreground break-all">{pathname}</span>.
          Check the address, or go back to where you started.
        </p>
      </div>
      <Link
        to={isAuthenticated ? "/" : "/login"}
        className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        {isAuthenticated ? "Go to the dashboard" : "Sign in"}
      </Link>
    </div>
  );
}

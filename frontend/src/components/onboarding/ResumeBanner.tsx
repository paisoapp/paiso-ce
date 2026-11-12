import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, X } from "@/lib/icons";
import { useOnboarding } from "./useOnboarding";

/**
 * Slim strip shown while setup is in progress ("active") and the user is
 * elsewhere in the app. It sits in the page column, in its own row below the
 * header, so it never covers navigation or a page's title. Continue →
 * the full-page wizard; the X dismisses entirely (resurrectable from
 * Settings → "Restart setup guide").
 */
export function ResumeBanner({ done, total }: { done: number; total: number }) {
  const navigate = useNavigate();
  const { dismiss } = useOnboarding();
  const [hidden, setHidden] = useState(false);

  if (hidden) return null;

  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-border bg-card px-4 py-2 text-sm lg:px-6 shrink-0"
    >
      <Sparkles className="h-4 w-4 text-primary shrink-0" />
      <span className="min-w-0 truncate">
        Setup: <span className="font-semibold">{done} of {total}</span> done
      </span>
      <button
        onClick={() => navigate("/welcome")}
        className="ml-auto shrink-0 rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Continue
      </button>
      <button
        aria-label="Dismiss setup"
        onClick={() => {
          // Hide for this pageview immediately; persist the dismissal.
          setHidden(true);
          dismiss();
        }}
        className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

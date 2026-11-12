import type { ReactNode } from "react";

export const primaryBtn =
  "inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50";

/**
 * The one row of navigation under a wizard step: Back on the left, the step's
 * single way forward on the right, and an optional skip beside it.
 *
 * Every step renders exactly one of these. Steps that save something put
 * their own button in it; the rest get the shell's "Continue". Two rows of
 * buttons that both moved forward is what this replaced.
 */
export function StepActions({
  onBack, onSkip, children,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  /** The primary action. */
  children?: ReactNode;
}) {
  return (
    <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border pt-5">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="px-4 py-2.5 text-sm border border-border rounded-md hover:bg-muted"
        >
          Back
        </button>
      )}
      <div className="flex-1" />
      {onSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="px-2 py-2.5 text-sm text-muted-foreground hover:text-foreground"
        >
          Skip for now
        </button>
      )}
      {children}
    </div>
  );
}

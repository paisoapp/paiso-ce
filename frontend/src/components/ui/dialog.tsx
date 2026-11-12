import * as React from "react";
import { X } from "@/lib/icons";
import { cn } from "@/lib/utils";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** False keeps the dialog open on a click outside it, for a multi-step
   *  flow where one stray click would lose the user's work. The close
   *  button and Escape still close it. */
  closeOnBackdrop?: boolean;
}

/** The header's id, so the dialog is announced by its title. */
const TitleId = React.createContext<string | undefined>(undefined);

// Bottom sheet on mobile (<md), centered card on md+.
export function Dialog({ open, onClose, children, className, closeOnBackdrop = true }: DialogProps) {
  const titleId = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    // Above a side drawer (z-50): a dialog is often opened from inside one.
    <div className="fixed inset-0 z-[60] flex items-end justify-center md:items-center md:p-4">
      <div className="absolute inset-0 bg-black/60" onClick={closeOnBackdrop ? onClose : undefined} />
      <div
        // Announced as a dialog, by its title, to a screen reader.
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "relative z-10 w-full max-h-[85dvh] md:max-h-[90vh] overflow-y-auto bg-card border border-border shadow-xl",
          "rounded-t-xl rounded-b-none md:rounded-xl pb-[env(safe-area-inset-bottom)] md:pb-0",
          className,
        )}
      >
        <TitleId.Provider value={titleId}>{children}</TitleId.Provider>
      </div>
    </div>
  );
}

export function DialogHeader({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  const titleId = React.useContext(TitleId);
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3 md:px-6 md:py-4">
      <div id={titleId} className="text-lg font-semibold">{children}</div>
      {onClose && (
        <button
          // Not a submit button: inside a form this was the first one, so
          // pressing Enter in a field closed the dialog instead of submitting.
          type="button"
          onClick={onClose}
          className="rounded-md p-2.5 -m-1.5 hover:bg-muted text-muted-foreground"
          aria-label="Close"
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function DialogBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("px-4 py-3 md:px-6 md:py-4", className)}>{children}</div>;
}

export function DialogFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 md:flex-row md:items-center md:justify-end md:px-6 md:py-4 [&>button]:w-full md:[&>button]:w-auto">
      {children}
    </div>
  );
}

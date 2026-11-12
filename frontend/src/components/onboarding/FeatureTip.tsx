import { useEffect, useRef, useState } from "react";
import { Lightbulb, X } from "@/lib/icons";
import { cn } from "@/lib/utils";
import { useFeatureTip } from "./useFeatureTip";

// Only one tip may auto-open at a time across the whole app. Tips that don't win
// the slot wait their turn, as a subtle pulsing marker the user can also click
// open, and the next one in line opens when the current one is dismissed or
// unmounts.
let autoClaim: string | null = null;
let waiting: { id: string; wake: () => void }[] = [];
const claimAuto = (id: string, wake: () => void) => {
  if (autoClaim === null || autoClaim === id) {
    autoClaim = id;
    waiting = waiting.filter((w) => w.id !== id);
    return true;
  }
  if (!waiting.some((w) => w.id === id)) waiting.push({ id, wake });
  return false;
};
const leaveQueue = (id: string) => {
  waiting = waiting.filter((w) => w.id !== id);
};
const releaseAuto = (id: string) => {
  if (autoClaim !== id) return;
  autoClaim = null;
  const next = waiting.shift();
  // A beat between tips, so the second does not read as the first reopening.
  if (next) setTimeout(next.wake, 600);
};

type Placement = "top" | "bottom" | "left" | "right" | "bottom-end" | "top-end";

// Desktop-only anchored placement. On mobile the popover becomes a
// viewport-pinned card (see below) so it can never be clipped off-screen.
const PLACEMENT: Record<Placement, string> = {
  bottom: "md:top-full md:left-0 md:mt-2",
  top: "md:bottom-full md:left-0 md:mb-2",
  right: "md:left-full md:top-0 md:ml-2",
  left: "md:right-full md:top-0 md:mr-2",
  "bottom-end": "md:top-full md:right-0 md:mt-2",
  "top-end": "md:bottom-full md:right-0 md:mb-2",
};

interface Props {
  id: string;
  title: string;
  /** Tip body copy. */
  children: React.ReactNode;
  /** Only surface the tip once the surrounding context is meaningful. */
  enabled?: boolean;
  placement?: Placement;
  className?: string;
}

/**
 * A one-time, self-contained "did you know" marker placed next to a feature.
 * Renders a small lightbulb pill; the first eligible tip on screen auto-opens a
 * popover, others open on click. Dismissal is persisted per `id`.
 */
export function FeatureTip({
  id,
  title,
  children,
  enabled = true,
  placement = "bottom",
  className,
}: Props) {
  const { shouldShow, dismiss } = useFeatureTip(id, enabled);
  // "auto": opened by itself, shown as a card in the corner of the screen so
  // it never sits over the headers and buttons it is about.
  // "anchored": opened by clicking its marker, beside the marker.
  const [open, setOpen] = useState<false | "auto" | "anchored">(false);
  const claimedRef = useRef(false);

  useEffect(() => {
    if (!shouldShow) return;
    let live = true;
    const wake = () => {
      if (!live) return;
      if (claimAuto(id, wake)) {
        claimedRef.current = true;
        setOpen((o) => o || "auto");
      }
    };
    wake();
    return () => {
      live = false;
      leaveQueue(id);
      if (claimedRef.current) releaseAuto(id);
    };
  }, [shouldShow, id]);

  if (!shouldShow) return null;

  const close = () => {
    setOpen(false);
    dismiss();
    releaseAuto(id);
  };

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => (v ? false : "anchored"))}
        aria-label={`Tip: ${title}`}
        className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary ring-2 ring-primary/30 animate-pulse hover:bg-primary/25"
      >
        <Lightbulb size={12} />
      </button>

      {open && (
        <span
          role="dialog"
          aria-label={title}
          className={cn(
            // Mobile: pinned near the bottom of the viewport, never clipped.
            "fixed inset-x-3 bottom-3 z-50 w-auto rounded-lg border border-border bg-card p-3 text-left shadow-xl",
            open === "auto"
              // Desktop, opened by itself: the bottom-right corner, clear of
              // the page's controls. The pulsing marker shows what it is about.
              ? "md:inset-auto md:bottom-6 md:right-6 md:w-72"
              // Desktop, opened from the marker: a popover beside it.
              : cn("md:absolute md:inset-auto md:w-64", PLACEMENT[placement]),
          )}
        >
          <span className="flex items-start justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <button
              type="button"
              onClick={close}
              className="rounded p-0.5 text-muted-foreground hover:bg-muted"
              aria-label="Dismiss tip"
            >
              <X size={14} />
            </button>
          </span>
          <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
            {children}
          </span>
          <button
            type="button"
            onClick={close}
            className="mt-2.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Got it
          </button>
        </span>
      )}
    </span>
  );
}

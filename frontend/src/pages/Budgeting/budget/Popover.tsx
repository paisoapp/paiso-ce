import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A pop-up anchored under its trigger on a computer, and a bottom sheet on a
 * phone: tapping a figure there opens the same content full width.
 * Closes on a click outside or Escape. `hover` also opens it when the pointer
 * rests on the trigger, on devices that have a pointer to rest.
 */
export function Popover({
  open,
  onOpenChange,
  trigger,
  children,
  align = "right",
  width = "md:w-80",
  hover = false,
  label,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  width?: string;
  hover?: boolean;
  /** Read out for the pop-up, and its title on a phone. */
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const leaveTimer = useRef<number>();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange]);

  const canHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (min-width: 768px)").matches;

  return (
    <div
      ref={ref}
      className="relative"
      // A pop-up sits inside a clickable row (the Budget tab's rows open a
      // drawer); clicks on it or its trigger stay with it.
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={hover ? () => { window.clearTimeout(leaveTimer.current); if (canHover()) onOpenChange(true); } : undefined}
      onMouseLeave={hover ? () => { if (canHover()) leaveTimer.current = window.setTimeout(() => onOpenChange(false), 150); } : undefined}
    >
      {trigger}
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30 md:hidden" aria-hidden onClick={() => onOpenChange(false)} />
          <div
            role="dialog"
            aria-label={label}
            className={cn(
              "fixed inset-x-0 bottom-0 z-50 max-h-[80vh] overflow-y-auto rounded-t-xl border border-border bg-card p-4 text-left font-normal shadow-lg",
              // On a computer it grows to fit rather than scrolling inside itself;
              // the page scrolls if it runs past the bottom.
              "md:absolute md:inset-x-auto md:bottom-auto md:top-full md:mt-1 md:max-h-none md:overflow-visible md:rounded-lg md:p-3",
              width,
              align === "right" ? "md:right-0" : "md:left-0",
            )}
          >
            <p className="mb-2 text-sm font-semibold md:hidden">{label}</p>
            {children}
          </div>
        </>
      )}
    </div>
  );
}

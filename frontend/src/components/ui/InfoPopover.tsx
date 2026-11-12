import { useEffect, useRef, useState } from "react";
import { Info } from "@/lib/icons";
import { cn } from "@/lib/utils";

/** Small click-to-toggle "i" popover for an inline explainer, shared across
 *  the app (Planning tabs, plan drawers, account settings). */
export function InfoPopover({
  label, children, align = "right", iconOnly = false,
}: {
  label: string;
  children: React.ReactNode;
  align?: "left" | "right";
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        title={iconOnly ? label : undefined}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Info size={13} />
        {!iconOnly && label}
      </button>
      {open && (
        <div
          className={cn(
            "absolute z-20 mt-1 w-72 rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground shadow-lg space-y-2",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";

interface PillTab {
  key: string;
  label: string;
  /** A route to link to (section tabs). Without it the pill is a button. */
  to?: string;
  end?: boolean;
  onSelect?: () => void;
}

/**
 * The phone form of every tab bar in the app: a row of pills that scrolls
 * sideways. Every tab is in view or a swipe away,
 * which the edge fade says; one tap switches; the active pill scrolls into the
 * middle of the strip. A tab bar that routes passes `to`, one that keeps its
 * tab in the query string passes `onSelect`, and both look and move the same.
 *
 * `pin` adds the pin button inside the active pill (SectionTabs).
 */
export function PillTabStrip({ items, activeKey, label, pin }: {
  items: PillTab[];
  activeKey: string | undefined;
  /** Names the strip for screen readers, e.g. "Settings section". */
  label?: string;
  pin?: {
    pinnedKey: string | undefined;
    title: (t: PillTab) => string;
    onToggle: (key: string) => void;
  };
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  const [fades, setFades] = useState({ left: false, right: false });
  const updateFades = useCallback(() => {
    const el = stripRef.current;
    if (!el) return;
    setFades({
      left: el.scrollLeft > 4,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    });
  }, []);
  useEffect(() => {
    const el = stripRef.current;
    const pill = el?.querySelector<HTMLElement>("[data-active]");
    if (el && pill) {
      el.scrollTo({ left: pill.offsetLeft - (el.clientWidth - pill.offsetWidth) / 2, behavior: "smooth" });
    }
    updateFades();
  }, [activeKey, updateFades]);
  useEffect(() => {
    window.addEventListener("resize", updateFades);
    return () => window.removeEventListener("resize", updateFades);
  }, [updateFades]);

  return (
    <div className="md:hidden relative -mx-4">
      <div
        ref={stripRef}
        onScroll={updateFades}
        role={items.some((t) => t.to) ? undefined : "tablist"}
        aria-label={label}
        className="flex gap-2 overflow-x-auto px-4 pb-1 snap-x [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((t) => {
          const isActive = activeKey === t.key;
          const isPinned = pin?.pinnedKey === t.key;
          const inner: ReactNode = (
            <>
              {t.label}
              {isPinned && !isActive && <Pin size={11} className="fill-current opacity-70" aria-label="Pinned" />}
            </>
          );
          const innerCls = cn(
            "flex items-center gap-1 whitespace-nowrap py-2 min-h-[40px]",
            isActive && pin ? "pl-4 pr-1" : "px-4",
          );
          return (
            <div
              key={t.key}
              data-active={isActive || undefined}
              className={cn(
                "flex shrink-0 snap-start items-center rounded-full border text-sm font-medium transition-colors",
                isActive
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground",
              )}
            >
              {t.to !== undefined ? (
                <NavLink to={t.to} end={t.end} className={innerCls}>{inner}</NavLink>
              ) : (
                <button type="button" role="tab" aria-selected={isActive} onClick={t.onSelect} className={innerCls}>
                  {inner}
                </button>
              )}
              {isActive && pin && (
                <button
                  type="button"
                  onClick={() => pin.onToggle(t.key)}
                  title={pin.title(t)}
                  aria-label={pin.title(t)}
                  aria-pressed={isPinned}
                  className="flex h-10 w-9 items-center justify-center rounded-r-full"
                >
                  <Pin size={13} className={cn(isPinned ? "fill-current" : "opacity-50")} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {fades.left && (
        <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background to-transparent" />
      )}
      {fades.right && (
        <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background to-transparent" />
      )}
    </div>
  );
}

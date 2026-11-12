import { Navigate, NavLink, useLocation, useResolvedPath } from "react-router-dom";
import { Pin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiPrefsStore } from "@/store/uiPrefs";
import { usePageTitle } from "@/lib/pageTitle";
import { PillTabStrip } from "./PillTabStrip";

interface SectionTab {
  /** Route path relative to the parent section route (e.g. "cash"). */
  to: string;
  label: string;
  end?: boolean;
}

/**
 * Section sub-navigation. On desktop it's the familiar underline tab strip;
 * below md it is a row of pills that scrolls sideways. Meant to sit inside a nested route (the `to` values are
 * resolved relative to the current route).
 *
 * With `pinSection`, the user can pin a tab: the section then opens on it
 * (see `PinnedTabRedirect`). The pin shows on the tab in view and on the
 * pinned one.
 */
export function SectionTabs({ items, className, pinSection }: {
  items: SectionTab[];
  className?: string;
  pinSection?: string;
}) {
  const { pathname } = useLocation();
  const base = useResolvedPath(".").pathname.replace(/\/+$/, "");
  const pinned = useUiPrefsStore((s) => (pinSection ? s.pinnedTabs[pinSection] : undefined));
  const setPinnedTab = useUiPrefsStore((s) => s.setPinnedTab);

  const resolve = (to: string) => (to === "" || to === "." ? base : `${base}/${to}`);
  const active =
    items.find((t) => {
      const full = resolve(t.to);
      return pathname === full || pathname.startsWith(full + "/");
    }) ?? items[0];
  usePageTitle("tab", active?.label);

  const togglePin = (to: string) => {
    if (!pinSection) return;
    setPinnedTab(pinSection, pinned === to ? null : to);
  };
  const pinTitle = (t: SectionTab) =>
    pinned === t.to ? `Unpin ${t.label}` : `Pin ${t.label}: open this section on it`;

  return (
    <div className={className}>
      {/* Mobile: a row of pills that scrolls sideways (shared with Settings). */}
      <PillTabStrip
        items={items.map((t) => ({ key: t.to, label: t.label, to: t.to, end: t.end }))}
        activeKey={active?.to}
        pin={pinSection ? { pinnedKey: pinned ?? undefined, title: (t) => pinTitle(items.find((i) => i.to === t.key)!), onToggle: togglePin } : undefined}
      />

      {/* Desktop: underline tab strip */}
      <div className="hidden md:flex gap-1 border-b border-border overflow-x-auto overflow-y-hidden">
        {items.map((t) => {
          const isPinned = pinned === t.to;
          const showPin = !!pinSection && (isPinned || active?.to === t.to);
          return (
            <div key={t.to} className="relative flex group">
              <NavLink
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  cn(
                    "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap",
                    // Room for the pin, kept on every tab so nothing shifts
                    // when the active tab changes.
                    pinSection && "pr-8",
                    isActive
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {t.label}
              </NavLink>
              {pinSection && (
                <button
                  type="button"
                  onClick={() => togglePin(t.to)}
                  title={pinTitle(t)}
                  aria-label={pinTitle(t)}
                  aria-pressed={isPinned}
                  className={cn(
                    "absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 transition-opacity",
                    isPinned ? "text-primary" : "text-muted-foreground hover:text-foreground",
                    showPin ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                  )}
                >
                  <Pin size={12} className={cn(isPinned && "fill-current")} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A section's index route: the pinned tab when it is still one of `items`
 *  (a gated tab can go away), else `fallback`. */
export function PinnedTabRedirect({ section, items, fallback }: {
  section: string;
  items: SectionTab[];
  fallback: string;
}) {
  const pinned = useUiPrefsStore((s) => s.pinnedTabs[section]);
  const to = pinned && items.some((t) => t.to === pinned) ? pinned : fallback;
  return <Navigate to={to} replace />;
}

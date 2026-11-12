import { NavLink } from "react-router-dom";
import {
  Settings,
  ChevronLeft,
  ChevronRight,
  X,
  Sun,
  Moon,
  Monitor,
  Contrast,
} from "@/lib/icons";
import { PaisoMark, Wordmark } from "@/components/brand/PaisoLogo";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";
import { useMe, displayName, avatarInitial, isNewAccount } from "@/hooks/useMe";
import { useAppInfo } from "@/hooks/useAppInfo";
import { NAV_ITEMS } from "@/lib/navRoutes";
import { FeatureTip } from "@/components/onboarding/FeatureTip";
import { useUiPrefsStore } from "@/store/uiPrefs";
import type { Mode } from "@/store/theme";

/** Icon and label per mode, in the order `cycle()` walks them. */
const MODE_ORDER: Mode[] = ["light", "dark", "gray", "system"];
const MODE_META: Record<Mode, { label: string; icon: typeof Sun }> = {
  light: { label: "Light mode", icon: Sun },
  dark: { label: "Dark mode", icon: Moon },
  gray: { label: "Gray mode", icon: Contrast },
  system: { label: "System mode", icon: Monitor },
};
const nextMode = (m: Mode): Mode =>
  MODE_ORDER[(MODE_ORDER.indexOf(m) + 1) % MODE_ORDER.length];

export function Sidebar({
  collapsed,
  onToggle,
  className,
  mobile = false,
}: {
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
  /** In the mobile drawer the toggle closes the drawer rather than collapsing. */
  mobile?: boolean;
}) {
  const { mode, cycle: cycleTheme } = useTheme();
  const { data: me } = useMe();
  // The setup wizard is behind the user (its last step, the snapshot, is
  // done; the optional guide may still be open), so a nudge will not crowd it.
  const onboardingDone = useUiPrefsStore((st) =>
    st.onboarding.status === "completed" || st.onboarding.status === "dismissed"
    || st.onboarding.completedSteps.includes("snapshot"));
  const { data: appInfo } = useAppInfo();
  const name = displayName(me);
  const initial = avatarInitial(me);

  return (
    <aside
      data-sidebar
      className={cn(
        "flex flex-col h-full bg-card border-r border-border transition-all duration-200",
        collapsed ? "w-16" : "w-56",
        className,
      )}
    >
      {/* Logo */}
      {/* 40px open, 32px collapsed: the collapsed rail is 64px less 32px of
          padding. Below 32px the artwork loses its detail. */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border shrink-0">
        <PaisoMark className={cn("shrink-0", collapsed ? "h-8 w-8" : "h-10 w-10")} />
        {!collapsed && (
          <Wordmark className="text-lg" />
        )}
      </div>

      {/* Nav links */}
      <nav className="flex-1 overflow-y-auto py-3 space-y-0.5 px-2">
        {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
          <div key={to} className="relative flex items-center">
          <NavLink
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              cn(
                "flex flex-1 items-center gap-3 px-2 py-2 min-h-[44px] rounded-md text-sm font-medium transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground",
              )
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span>{label}</span>}
          </NavLink>
          {/* After setup, point a new user at Cash Flow once: nothing else
              did, and Portfolio is where most of them land. New
              accounts only: an established account knows where it is. The
              id predates the rename and is kept so a dismissed tip
              stays dismissed. */}
          {to === "/cashflow" && !collapsed && (
            <FeatureTip
              id="nav-budgeting"
              title="Try Cash Flow"
              enabled={onboardingDone && isNewAccount(me)}
              placement="right"
              className="absolute right-2"
            >
              See where your money went this month, compare it with past months, and set a
              budget that keeps up with your spending.
            </FeatureTip>
          )}
          </div>
        ))}
      </nav>

      {/* Bottom actions */}
      <div className="px-2 pb-3 space-y-0.5 border-t border-border pt-2">
        {/* Logged-in user → My Account */}
        <NavLink
          to="/settings?tab=account"
          title={collapsed ? name : undefined}
          className={cn(
            "flex items-center gap-3 px-2 py-2 min-h-[44px] rounded-md text-sm font-medium text-foreground transition-colors",
            "hover:bg-accent hover:text-accent-foreground",
          )}
        >
          {me?.avatar ? (
            <img
              src={me.avatar}
              alt=""
              className="h-4 w-4 rounded-full object-cover shrink-0"
            />
          ) : (
            <div className="h-4 w-4 rounded-full bg-primary/15 text-primary flex items-center justify-center text-[9px] font-bold shrink-0">
              {initial}
            </div>
          )}
          {!collapsed && <span className="truncate min-w-0" data-private>{name || "—"}</span>}
        </NavLink>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 px-2 py-2 min-h-[44px] rounded-md text-sm font-medium transition-colors",
              "hover:bg-accent hover:text-accent-foreground",
              isActive ? "bg-primary/10 text-primary" : "text-muted-foreground",
            )
          }
        >
          <Settings className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Settings</span>}
        </NavLink>
        <button
          onClick={cycleTheme}
          className="flex w-full items-center gap-3 px-2 py-2 min-h-[44px] rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          // The name starts with what the button shows, then says what a
          // click does, so a screen reader and the tooltip agree with the label.
          aria-label={`${MODE_META[mode].label}. Switch to ${MODE_META[nextMode(mode)].label.toLowerCase()}`}
          title={`Switch to ${MODE_META[nextMode(mode)].label.toLowerCase()}`}
        >
          {(() => {
            const Icon = MODE_META[mode].icon;
            return <Icon className="h-4 w-4 shrink-0" />;
          })()}
          {!collapsed && <span>{MODE_META[mode].label}</span>}
        </button>
        <button
          onClick={onToggle}
          aria-label={mobile ? "Close menu" : collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="flex w-full items-center gap-3 px-2 py-2 min-h-[44px] rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          {mobile ? (
            <>
              <X className="h-4 w-4 shrink-0" />
              <span>Close</span>
            </>
          ) : collapsed ? (
            <ChevronRight className="h-4 w-4 shrink-0" />
          ) : (
            <>
              <ChevronLeft className="h-4 w-4 shrink-0" />
              <span>Collapse</span>
            </>
          )}
        </button>

        {/* Which build this is. It used to headline the About tab alongside the
            commit, build time and release history — operator detail on a
            user-facing page. Here it is quiet, always visible, and still
            readable back to support; the full string and channel are on the
            tooltip. */}
        {!collapsed && appInfo?.version && (
          <p
            className="px-2 pt-1 text-[10px] text-muted-foreground/60 tabular-nums truncate"
            title={`${appInfo.version_string}${appInfo.channel ? ` · ${appInfo.channel}` : ""}`}
          >
            v{appInfo.version}
          </p>
        )}
      </div>
    </aside>
  );
}

import { NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  PieChart,
  TrendingUp,
  Receipt,
  Menu,
} from "@/lib/icons";
import { cn } from "@/lib/utils";

// Labels and order mirror the sidebar so the two navs read consistently.
const TABS = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/portfolio", icon: PieChart, label: "Portfolio" },
  { to: "/investments", icon: TrendingUp, label: "Investments" },
  { to: "/cashflow", icon: Receipt, label: "Cash Flow" },
] as const;

const itemClass = (active: boolean) =>
  cn(
    "flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 min-h-[48px] rounded-md text-[10px] font-medium leading-tight transition-colors",
    active ? "text-primary" : "text-muted-foreground",
  );

/** App-like bottom tab bar, shown below lg. "More" opens the nav drawer. */
export function BottomNav({ onMore }: { onMore: () => void }) {
  const { pathname } = useLocation();
  const tabs = TABS;
  // "More" lights up when none of the visible tabs matches the current route.
  const onTabRoute =
    pathname === "/" ||
    tabs.some(({ to }) => to !== "/" && pathname.startsWith(to));

  return (
    <nav
      className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]"
      aria-label="Primary"
    >
      <div className="flex items-stretch h-16 px-1">
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => itemClass(isActive)}>
            <Icon className="h-5 w-5 shrink-0" />
            <span className="max-w-full truncate">{label}</span>
          </NavLink>
        ))}
        <button onClick={onMore} className={itemClass(!onTabRoute)}>
          <Menu className="h-5 w-5 shrink-0" />
          <span className="max-w-full truncate">More</span>
        </button>
      </div>
    </nav>
  );
}

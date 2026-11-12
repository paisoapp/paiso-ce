import {
  LayoutDashboard,
  PieChart,
  TrendingUp,
  Receipt,
  ArrowLeftRight,
} from "@/lib/icons";

// Shared with the sidebar nav and the "default landing page" setting, so the
// two stay in sync without duplicating the route list.
export const NAV_ITEMS = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/portfolio", icon: PieChart, label: "Portfolio" },
  { to: "/investments", icon: TrendingUp, label: "Investments" },
  { to: "/cashflow", icon: Receipt, label: "Cash Flow" },
  { to: "/transactions", icon: ArrowLeftRight, label: "Transactions" },
] as const;

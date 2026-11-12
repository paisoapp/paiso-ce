import type { ComponentType } from "react";
import {
  Building2, Home, Landmark, LineChart, PieChart, PiggyBank,
  Receipt, SlidersHorizontal, TrendingUp, Users, Wallet,
} from "@/lib/icons";

type Icon = ComponentType<{ className?: string }>;

export interface Option {
  id: string;
  label: string;
  /** One line under the label, for the larger cards. */
  hint?: string;
  icon?: Icon;
}

/** "What brings you to Paiso?" Multi-select. */
export const GOALS: Option[] = [
  { id: "spending", label: "See where my money goes", hint: "Spending by category, month by month", icon: PieChart },
  { id: "net_worth", label: "Track my net worth", hint: "Everything I own and owe in one number", icon: Wallet },
  { id: "investments", label: "Track my investments", hint: "Holdings, gains and performance", icon: TrendingUp },
  { id: "budget", label: "Build a budget and measure it", hint: "Set monthly targets and see how I do", icon: SlidersHorizontal },
  { id: "organized", label: "Get my finances organized", hint: "One place for all of it", icon: Receipt },
];

/** "How do you manage your finances today?" Single-select. */
export const MANAGE: Option[] = [
  { id: "manual", label: "Mostly by hand" },
  { id: "spreadsheets", label: "Spreadsheets" },
  { id: "apps", label: "A few different apps" },
  { id: "advisor", label: "An advisor or financial professional" },
  { id: "none", label: "I do not really have a system" },
];

/** "Which of these do you have?" Multi-select. */
export const HAVE: Option[] = [
  { id: "checking", label: "Checking or savings", icon: Landmark },
  { id: "credit_cards", label: "Credit cards", icon: Receipt },
  { id: "brokerage", label: "Brokerage accounts", icon: LineChart },
  { id: "retirement", label: "Retirement accounts", icon: PiggyBank },
  { id: "college", label: "529 or college savings", icon: Users },
  { id: "real_estate", label: "Real estate", icon: Home },
  { id: "other", label: "Something else", icon: Building2 },
];

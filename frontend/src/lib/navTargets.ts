import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Where a card, chart mark or row on the Dashboard / Portfolio page leads.
 *
 * One map, so a 401(k) slice, a 401(k) account row and a 401(k) fee line all
 * go to the same place.
 */
export function cashFlowHref(sub: "overview" | "income" | "expenses" | "transfers" | "budget"): string {
  return `/cashflow/${sub}`;
}

/** Where an old /budgeting link now goes: the section moved to
 *  /cashflow, its Cash Flow tab became Overview and Performance became Budget.
 *  Bookmarks, help articles and old emails still carry the old paths. */
export function cashFlowPathFromLegacy(pathname: string): string {
  const [tab = "", ...rest] = pathname.replace(/^\/budgeting\/?/, "").split("/");
  const renamed = tab === "cashflow" ? "overview" : tab === "performance" ? "budget" : tab;
  return ["/cashflow", renamed, ...rest].filter(Boolean).join("/").replace(/^\/?/, "/");
}

/** Investment-account type (or tracker kind) → its Investments tab. */
function investmentHref(type: string): string {
  // Each account lives on the tab for its investment type.
  if (type === "529") return "/investments/education";
  if (type === "hsa") return "/investments/health";
  if (type === "401k" || type === "ira" || type === "roth_ira") return "/investments/retirement";
  return "/investments/stocks";
}

/** A portfolio `asset_breakdown` label → where that money is managed. */
export function assetClassHref(key: string): string {
  switch (key) {
    case "cash": return "/transactions/cash";
    case "property": return "/investments/property";
    case "other_assets": return "/investments/other";
    default: return investmentHref(key);
  }
}

/** Any account type (cash, card, loan, investment) → its page. With an
 *  account id, a Transactions tab opens filtered to that one account. */
export function accountHref(type: string, accountId?: number): string {
  const only = accountId ? `?account=${accountId}` : "";
  switch (type) {
    case "checking":
    case "savings": return `/transactions/cash${only}`;
    case "credit_card": return `/transactions/credit-cards${only}`;
    case "loan": return `/transactions/loan${only}`;
    case "mortgage": return `/transactions/mortgage${only}`;
    case "primary_home":
    case "rental": return "/investments/property";
    default: return investmentHref(type);
  }
}

const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"], [role="switch"], [role="tab"], [data-no-card-nav]';

/**
 * Click handler that makes a whole card navigate, without hijacking what's
 * inside it: clicks on links/buttons/inputs, clicks that bubble up from a
 * portal (a date-picker popover), and clicks that end a text selection are
 * all left alone. The card's title stays a real link for keyboard users.
 */
export function useCardClick(to: string | undefined) {
  const navigate = useNavigate();
  return useCallback(
    (e: React.MouseEvent<HTMLElement>) => navigateFromClick(e, to, navigate),
    [navigate, to],
  );
}

/** The guard behind `useCardClick`, for callers whose target varies per row. */
export function navigateFromClick(
  e: React.MouseEvent<HTMLElement>,
  to: string | undefined,
  navigate: (to: string) => void,
) {
  if (!to || e.defaultPrevented || e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!e.currentTarget.contains(target)) return;
  const interactive = target.closest(INTERACTIVE);
  if (interactive && interactive !== e.currentTarget) return;
  if (window.getSelection()?.toString()) return;
  if (e.metaKey || e.ctrlKey) {
    window.open(to, "_blank", "noopener");
    return;
  }
  navigate(to);
}

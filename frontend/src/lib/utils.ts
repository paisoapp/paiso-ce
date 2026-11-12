import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { getDisplayScale } from "@/store/displayMode";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value * getDisplayScale());
}

export function formatCurrencyFull(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value * getDisplayScale());
}

export function formatCompact(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value * getDisplayScale());
}

/**
 * Boolean search with AND / OR / NOT operators (case-insensitive).
 * Space-separated terms within an OR group are implicitly ANDed.
 * Examples:
 *   "AMZN AND AAPL"        → must match both
 *   "AMZN OR AAPL"         → must match either
 *   "AMZN AND NOT VANGUARD" → must match AMZN, must not contain VANGUARD
 */
export function matchesSearch(haystack: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const lower = haystack.toLowerCase();
  // Split by OR first (lowest precedence)
  const orGroups = q.split(/\bOR\b/i);
  return orGroups.some((group) => {
    const tokens = group.trim().split(/\s+/).filter(Boolean);
    let result = true;
    let negate = false;
    let firstTerm = true;
    for (const token of tokens) {
      if (/^AND$/i.test(token)) continue;
      if (/^NOT$/i.test(token)) { negate = true; continue; }
      const termMatches = lower.includes(token.toLowerCase());
      const termResult = negate ? !termMatches : termMatches;
      negate = false;
      if (firstTerm) { result = termResult; firstTerm = false; }
      else result = result && termResult;
    }
    return firstTerm ? true : result;
  });
}

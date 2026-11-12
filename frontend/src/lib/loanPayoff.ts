import type { AssetLoan } from "@/hooks/useAssets";

// Loan payoff math shared by the property drawer (pages/Investments/
// PropertyPage.tsx) and the sign-up page's mortgage card
// (components/auth/AuthShell.tsx), so both give the same date.

/** The level monthly principal-and-interest payment that pays `principal` off
 *  over `months` at `aprPct`: the standard amortization formula, the same one
 *  the server's schedule uses. Zero until the three inputs make sense. */
export function monthlyPrincipalAndInterest(principal: number, aprPct: number, months: number): number {
  if (!(principal > 0) || !(months >= 1) || !(aprPct >= 0)) return 0;
  const r = aprPct / 100 / 12;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

interface PayoffInfo {
  payoffDateStr: string;
  totalMonths: number;
}

export function computePayoffInfo(
  loan: Pick<AssetLoan, "principal" | "rate_apr" | "term_months" | "origination">,
  extraMonthly: number,
  balanceOverride: number | null,
  balanceOverrideDate: string | null,
): PayoffInfo {
  const monthlyRate = loan.rate_apr / 100 / 12;
  let remaining: number, startMonth1: number, startYear: number, balance: number;

  if (balanceOverride != null && balanceOverride > 0 && balanceOverrideDate) {
    const orig = new Date(loan.origination + "T00:00:00");
    const ov = new Date(balanceOverrideDate + "T00:00:00");
    const elapsed = (ov.getFullYear() - orig.getFullYear()) * 12 + (ov.getMonth() - orig.getMonth());
    remaining = Math.max(1, loan.term_months - elapsed);
    startMonth1 = ov.getMonth() + 1;
    startYear = ov.getFullYear();
    balance = balanceOverride;
  } else {
    remaining = loan.term_months;
    const orig = new Date(loan.origination + "T00:00:00");
    startMonth1 = orig.getMonth() + 1;
    startYear = orig.getFullYear();
    balance = loan.principal;
  }

  const basePayment = monthlyPrincipalAndInterest(balance, loan.rate_apr, remaining);

  let b = balance;
  let totalMonths = remaining;
  for (let i = 1; i <= remaining; i++) {
    const interest = b * monthlyRate;
    const principalPmt = Math.min(basePayment - interest + extraMonthly, b);
    b = Math.max(0, b - principalPmt);
    if (b <= 0) { totalMonths = i; break; }
  }

  const m1 = ((startMonth1 - 1 + totalMonths) % 12) + 1;
  const y = startYear + Math.floor((startMonth1 - 1 + totalMonths) / 12);
  return {
    payoffDateStr: new Date(y, m1 - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    totalMonths,
  };
}

/** The balance left after `paid` level monthly payments, on the same
 *  schedule as monthlyPrincipalAndInterest. */
export function balanceAfterPayments(principal: number, aprPct: number, months: number, paid: number): number {
  const payment = monthlyPrincipalAndInterest(principal, aprPct, months);
  const r = aprPct / 100 / 12;
  let b = principal;
  for (let i = 0; i < Math.min(paid, months) && b > 0; i++) {
    b = Math.max(0, b - (payment - b * r));
  }
  return b;
}

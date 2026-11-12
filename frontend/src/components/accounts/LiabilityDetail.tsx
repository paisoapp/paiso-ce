import { formatCurrency } from "@/lib/utils";
import type { AccountLiability } from "@/types";
import { formatDate } from "@/lib/dates";

function fmtDate(iso: string | null) {
  return iso ? formatDate(iso) : null;
}

/** 181 months as "15 years, 1 month", not 15.083333333333334 years. */
function termText(months: number): string {
  const whole = Math.round(months);
  const years = Math.floor(whole / 12);
  const rest = whole % 12;
  const y = years ? `${years} ${years === 1 ? "year" : "years"}` : "";
  const m = rest ? `${rest} ${rest === 1 ? "month" : "months"}` : "";
  return [y, m].filter(Boolean).join(", ") || "0 months";
}

/**
 * APR, statement and payment detail for a card, loan or mortgage.
 *
 * Entered by hand on the account.
 */
export function LiabilityDetail({ liability }: { liability: AccountLiability }) {
  const rows: [string, string | null][] = [
    ["APR", liability.apr_pct != null ? `${liability.apr_pct.toFixed(2)}%` : null],
    [
      "Minimum payment",
      liability.minimum_payment != null ? formatCurrency(liability.minimum_payment) : null,
    ],
    ["Next payment due", fmtDate(liability.next_payment_due_date)],
    [
      "Last payment",
      liability.last_payment_amount != null
        ? `${formatCurrency(liability.last_payment_amount)}${
            liability.last_payment_date ? ` on ${fmtDate(liability.last_payment_date)}` : ""
          }`
        : null,
    ],
    [
      "Last statement",
      liability.last_statement_balance != null
        ? `${formatCurrency(liability.last_statement_balance)}${
            liability.last_statement_date ? ` on ${fmtDate(liability.last_statement_date)}` : ""
          }`
        : null,
    ],
    [
      "Original amount",
      liability.origination_principal != null
        ? formatCurrency(liability.origination_principal)
        : null,
    ],
    ["Originated", fmtDate(liability.origination_date)],
    ["Matures", fmtDate(liability.maturity_date)],
    ["Term", liability.term_months ? termText(liability.term_months) : null],
    [
      "Escrow balance",
      liability.escrow_balance != null ? formatCurrency(liability.escrow_balance) : null,
    ],
  ];
  const present = rows.filter(([, value]) => value);
  if (present.length === 0) return null;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="flex items-center gap-1 text-sm font-semibold">
          Loan & payment detail
        </h4>
        {liability.is_overdue && (
          <span className="text-xs font-semibold rounded-full bg-destructive/10 text-destructive px-2 py-0.5">
            Overdue
          </span>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
        {present.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

import { Link } from "react-router-dom";
import { ArrowRight } from "@/lib/icons";
import { useTransactions } from "@/hooks/useTransactions";

/**
 * One-line reconciliation note shown under the Income/Expense transaction tables.
 * Explains that some transactions were excluded (transfers, payments, refunds,
 * reimbursements) and links to the Transfers tab where they live in full.
 */
export function TransfersNote({
  dateFrom,
  dateTo,
  accountId,
  noun = "income",
}: {
  dateFrom?: string;
  dateTo?: string;
  accountId?: number;
  /** What these transfers are *not* counted toward, e.g. "income" or "expenses". */
  noun?: string;
}) {
  // Lightweight count-only query (page_size 1 — we only read the totals).
  const { data } = useTransactions({
    date_from: dateFrom,
    date_to: dateTo,
    account_id: accountId,
    only_transfers: true,
    page_size: 1,
  });

  const count = data?.total ?? 0;
  if (count === 0) return null;

  return (
    <Link
      to="/cashflow/transfers"
      className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
    >
      <span>
        <span className="font-medium text-foreground">{count}</span>{" "}
        transfer{count === 1 ? "" : "s"} &amp; payment{count === 1 ? "" : "s"} excluded from {noun} this period.
      </span>
      <span className="flex shrink-0 items-center gap-1 text-primary">
        View in Transfers
        <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

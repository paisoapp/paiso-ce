import { useState } from "react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import {
  TRANSFER_KIND_LABEL,
  useConfirmTransfer,
  useRejectTransfer,
  useTransferLinks,
} from "@/hooks/useTransfers";

/**
 * Review queue for suggested transfer pairs.
 *
 * The matcher never links anything on its own — a wrong pair mislabels two
 * real transactions and hides one from the user's spending, and nothing on
 * screen would make that obvious. So every suggestion is confirmed by hand,
 * and dismissing one is remembered so it is not proposed again.
 */
/** Most a review queue may ever put in front of someone at once.
 *
 *  The matcher no longer proposes pairs whose confirmation would change
 *  nothing, so this should rarely bind — but a queue that can render an
 *  unbounded list is a queue that can become a wall of a hundred rows, and
 *  a wall does not get reviewed, it gets ignored. */
const MAX_VISIBLE = 5;

export function TransferReview() {
  // Off by default. A transfer is already net-worth-neutral without being
  // linked — the categorizer handles that —
  // so the queue is a refinement, and a refinement must not become a chore.
  // Anything the matcher can identify is linked automatically regardless; this
  // only decides whether the leftovers are shown.
  const { data: links = [], isLoading } = useTransferLinks("suggested");
  const confirm = useConfirmTransfer();
  const reject = useRejectTransfer();
  const [showAll, setShowAll] = useState(false);

  if (isLoading || links.length === 0) return null;

  const visible = showAll ? links : links.slice(0, MAX_VISIBLE);
  const hidden = links.length - visible.length;

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">
          {links.length} possible transfer{links.length === 1 ? "" : "s"} to review
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          These look like two sides of one movement, and at least one side is
          still counted as spending or income. Linking them makes both neutral.
        </p>
      </div>

      <ul className="divide-y divide-border/60">
        {visible.map((link) => {
          const busy =
            confirm.isPending || reject.isPending;
          return (
            <li key={link.id} className="py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm truncate">
                  <span className="font-medium">
                    {link.outflow?.account_name ?? "Unknown"}
                  </span>
                  <span className="text-muted-foreground"> → </span>
                  <span className="font-medium">
                    {link.inflow?.account_name ?? "Unknown"}
                  </span>
                  <span className="ml-2 tabular-nums">{formatCurrency(link.amount)}</span>
                </p>
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {TRANSFER_KIND_LABEL[link.kind] ?? link.kind}
                  {link.outflow?.date_posted && ` · ${link.outflow.date_posted}`}
                  {link.outflow?.description && ` · ${link.outflow.description}`}
                </p>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => confirm.mutate(link.id)}
                >
                  Link
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  title="Do not suggest this pair again"
                  onClick={() => reject.mutate(link.id)}
                >
                  Not a transfer
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {hidden > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="text-xs text-primary hover:underline"
        >
          Show {hidden} more
        </button>
      )}
      {showAll && links.length > MAX_VISIBLE && (
        <button
          onClick={() => setShowAll(false)}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface TransferSide {
  transaction_id: number;
  description: string | null;
  date_posted: string | null;
  amount: number;
  account_name: string | null;
}

interface TransferLink {
  id: number;
  status: "suggested" | "confirmed" | "rejected";
  kind: string;
  source: "auto" | "manual";
  confidence: number;
  amount: number;
  matched_on: string | null;
  outflow: TransferSide | null;
  inflow: TransferSide | null;
}

export const TRANSFER_KIND_LABEL: Record<string, string> = {
  credit_card_payment: "Card payment",
  loan_payment: "Loan payment",
  account_transfer: "Transfer",
  investment_contribution: "Contribution",
};

export function useTransferLinks(status = "suggested", enabled = true) {
  return useQuery<TransferLink[]>({
    queryKey: ["transfers", "links", status],
    queryFn: () => api.get(`/transfers/links?status=${status}`),
    // Reading the suggested queue reconciles it server-side, so this is not a
    // free call — don't make it when the queue is not being shown.
    enabled,
  });
}

/** Confirm / reject / unlink all invalidate the transaction list too, since
 *  confirming moves both legs into a transfer category. */
function useLinkMutation(run: (id: number) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["transfers"] });
      qc.invalidateQueries({ queryKey: ["transactions"] });
      qc.invalidateQueries({ queryKey: ["budget"] });
    },
  });
}

export function useConfirmTransfer() {
  return useLinkMutation((id) => api.post(`/transfers/links/${id}/confirm`));
}

export function useRejectTransfer() {
  return useLinkMutation((id) => api.post(`/transfers/links/${id}/reject`));
}

export function useUnlinkTransfer() {
  return useLinkMutation((id) => api.delete(`/transfers/links/${id}`));
}

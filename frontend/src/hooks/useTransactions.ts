import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { AccountTypeGroup, PaginatedTransactions, Transaction, TransactionAttachment } from "@/types";

export interface TransactionFilters {
  account_id?: number;
  account_type_group?: AccountTypeGroup;
  category_id?: number;
  date_from?: string;
  date_to?: string;
  search?: string;
  uncategorized?: boolean;
  exclude_transfers?: boolean;
  only_transfers?: boolean;
  only_pending?: boolean;
  exclude_pending?: boolean;
  amount_sign?: "positive" | "negative" | "income" | "spending";
  /** Leave out payments received on a loan's own ledger, as budgets count a category. */
  exclude_loan_credits?: boolean;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  page?: number;
  page_size?: number;
  fetch_all?: boolean;
}

function buildQS(filters: TransactionFilters): string {
  const p = new URLSearchParams();
  if (filters.account_id) p.set("account_id", String(filters.account_id));
  if (filters.account_type_group) p.set("account_type_group", filters.account_type_group);
  if (filters.category_id) p.set("category_id", String(filters.category_id));
  if (filters.date_from) p.set("date_from", filters.date_from);
  if (filters.date_to) p.set("date_to", filters.date_to);
  if (filters.search) p.set("search", filters.search);
  if (filters.uncategorized) p.set("uncategorized", "true");
  if (filters.exclude_transfers) p.set("exclude_transfers", "true");
  if (filters.only_transfers) p.set("only_transfers", "true");
  if (filters.only_pending) p.set("only_pending", "true");
  if (filters.exclude_pending) p.set("exclude_pending", "true");
  if (filters.amount_sign) p.set("amount_sign", filters.amount_sign);
  if (filters.exclude_loan_credits) p.set("exclude_loan_credits", "true");
  if (filters.sort_by) p.set("sort_by", filters.sort_by);
  if (filters.sort_order) p.set("sort_order", filters.sort_order);
  if (filters.page) p.set("page", String(filters.page));
  if (filters.page_size) p.set("page_size", String(filters.page_size));
  if (filters.fetch_all) p.set("fetch_all", "true");
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function useTransactions(filters: TransactionFilters = {}) {
  return useQuery<PaginatedTransactions>({
    queryKey: ["transactions", filters],
    queryFn: () => api.get<PaginatedTransactions>(`/transactions${buildQS(filters)}`),
    // Changing tab, page or filter makes a new query key. Without this the
    // table fell back to its skeleton every time — the blank flash on every
    // tab switch — instead of holding the rows it already had. The breakdown
    // above it has always done this. [issue 210]
    placeholderData: (prev) => prev,
  });
}

export interface BreakdownGroup {
  /** Account-type group ("cash", "credit_cards", …) or an account id. */
  key: string;
  label: string;
  /** Set when grouping by account. */
  account_type: string | null;
  count: number;
  inflow: number;
  outflow: number;
  net: number;
}

export interface TransactionBreakdown {
  group_by: "type_group" | "account";
  total_count: number;
  total_inflow: number;
  total_outflow: number;
  groups: BreakdownGroup[];
  /** On the Credit Cards, Loan and Mortgage tabs: the rows read from the
   *  debt's side, with a payment listed on both sides counted once. */
  debt?: {
    /** Payments and credits toward the debt. */
    paid: number;
    /** Purchases, interest, fees and escrow added to it. */
    charged: number;
    net_paid: number;
    /** Bank-side payments not counted again: the lender's credit is listed too. */
    matched_payments: number;
    /** Loan and Mortgage tabs: what was paid, split into principal, interest
     *  and the rest (escrow, fees), and where that split came from. */
    split?: {
      principal: number;
      interest: number;
      other: number;
      /** reported: the lender's own figures; payments: each payment split
       *  from the loan's rate and balance; the rest are estimates. */
      basis: "reported" | "payments" | "loan_details" | "lender_share" | "balance" | null;
      estimated: boolean;
      /** Principal paid over and above the regular payments. */
      extra?: number;
      /** The rate the payments were split with (percent), when one loan. */
      rate?: number | null;
    };
  };
}

/** How the rows matching `filters` split by account type or account.
 *  Paging and sorting don't change the split, so they're left out of the key. */
export function useTransactionBreakdown(
  filters: TransactionFilters,
  groupBy: "type_group" | "account",
  enabled = true,
) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { page, page_size, fetch_all, sort_by, sort_order, ...rest } = filters;
  const qs = buildQS(rest);
  return useQuery<TransactionBreakdown>({
    queryKey: ["transactions", "breakdown", groupBy, rest],
    queryFn: () => api.get<TransactionBreakdown>(`/transactions/breakdown${qs ? `${qs}&` : "?"}group_by=${groupBy}`),
    enabled,
    placeholderData: (prev) => prev,
  });
}

/** A changed transaction moves the budget's Used figures too: a transaction
 *  edited from a budget category's drawer refreshes the Budget tab and
 *  the drawer under it, not only the transaction lists. */
function refreshAfterEdit(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["transactions"] });
  qc.invalidateQueries({ queryKey: ["budget"] });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: number;
      category_id?: number | null;
      notes?: string | null;
      tags?: string | null;
      description?: string;
    }) => api.patch<Transaction>(`/transactions/${id}`, body),
    onSuccess: () => refreshAfterEdit(qc),
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      account_id: number;
      date_posted: string;
      description: string;
      amount: number;
      transaction_type?: string;
      category_id?: number;
      notes?: string;
    }) => api.post<Transaction>("/transactions", body),
    onSuccess: () => refreshAfterEdit(qc),
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete(`/transactions/${id}`),
    onSuccess: () => refreshAfterEdit(qc),
  });
}

export function useMarkDuplicate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, is_duplicate }: { id: number; is_duplicate: boolean }) =>
      api.patch<Transaction>(`/transactions/${id}/duplicate`, { is_duplicate }),
    onSuccess: () => refreshAfterEdit(qc),
  });
}

export function useBulkUpdateTransactions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      transaction_ids: number[];
      category_id?: number | null;
      description?: string;
      notes?: string | null;
    }) => api.post("/transactions/bulk-update", body),
    onSuccess: () => refreshAfterEdit(qc),
  });
}

/** One transaction like the open one, as the drawer lists it. */
interface SimilarTransaction {
  id: number;
  date_posted: string;
  description: string | null;
  amount: number;
  account_name: string;
  category_id: number | null;
  category_name: string | null;
}

interface SimilarOut {
  count: number;
  ids: number[];
  transactions: SimilarTransaction[];
}

export function useSimilarTransactions(id: number | null, enabled: boolean) {
  return useQuery<SimilarOut>({
    queryKey: ["transactions", id, "similar"],
    queryFn: () => api.get<SimilarOut>(`/transactions/${id}/similar`),
    enabled: enabled && id != null,
  });
}

export function useTransactionAttachments(txnId: number | null) {
  return useQuery<TransactionAttachment[]>({
    queryKey: ["transactions", txnId, "attachments"],
    queryFn: () => api.get<TransactionAttachment[]>(`/transactions/${txnId}/attachments`),
    enabled: txnId != null,
  });
}

export function useUploadAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, file }: { txnId: number; file: File }) => {
      const fd = new FormData();
      fd.append("file", file);
      return api.upload<TransactionAttachment>(`/transactions/${txnId}/attachments`, fd);
    },
    onSuccess: (_data, { txnId }) =>
      qc.invalidateQueries({ queryKey: ["transactions", txnId, "attachments"] }),
  });
}

export function useDeleteAttachment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ txnId, attId }: { txnId: number; attId: number }) =>
      api.delete(`/transactions/${txnId}/attachments/${attId}`),
    onSuccess: (_data, { txnId }) =>
      qc.invalidateQueries({ queryKey: ["transactions", txnId, "attachments"] }),
  });
}

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Copy, FileUp, Paperclip, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { CategoryPicker } from "@/components/ui/CategoryPicker";
import { useUnlinkTransfer } from "@/hooks/useTransfers";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { MerchantLogo } from "@/components/ui/MerchantLogo";
import { AccountLogo } from "@/components/accounts/AccountList";
import { useAccounts } from "@/hooks/useAccounts";
import {
  useUpdateTransaction,
  useDeleteTransaction,
  useMarkDuplicate,
  useBulkUpdateTransactions,
  useSimilarTransactions,
  useTransactionAttachments,
  useUploadAttachment,
  useDeleteAttachment,
} from "@/hooks/useTransactions";
import { cn, formatCurrencyFull } from "@/lib/utils";
import { RECEIPT_ACCEPT, UPLOAD_LIMITS, tooLarge } from "@/lib/uploadLimits";
import { toastError } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { Transaction } from "@/types";
import { formatDate } from "@/lib/dates";

interface TransactionDrawerProps {
  transaction: Transaction | null;
  onClose: () => void;
}

export function TransactionDrawer({ transaction, onClose }: TransactionDrawerProps) {
  // Local form state — reset whenever the transaction changes
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [applyToSimilar, setApplyToSimilar] = useState(false);
  // The similar transactions the change applies to; null until they load.
  const [similarPicked, setSimilarPicked] = useState<Set<number> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The account's bank logo beside its name.
  const { data: accounts } = useAccounts();
  const account = transaction ? accounts?.find((a) => a.id === transaction.account_id) : undefined;

  useEffect(() => {
    if (transaction) {
      setDescription(transaction.description ?? "");
      setCategoryId(transaction.category_id);
      setNotes(transaction.notes ?? "");
      setApplyToSimilar(false);
      setSimilarPicked(null);
      setConfirmDelete(false);
    }
  }, [transaction?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = useUpdateTransaction();
  const deleteTxn = useDeleteTransaction();
  const markDuplicate = useMarkDuplicate();
  const bulkUpdate = useBulkUpdateTransactions();
  const uploadAtt = useUploadAttachment();
  const deleteAtt = useDeleteAttachment();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachmentsQuery = useTransactionAttachments(transaction?.id ?? null);
  const attachments = attachmentsQuery.data ?? [];

  // "Similar" query — only fires when the toggle is on
  const similarQuery = useSimilarTransactions(
    transaction?.id ?? null,
    applyToSimilar
  );

  // Every match starts ticked except money going the other way: a refund
  // from the landlord is not rent.
  const similar = similarQuery.data?.transactions;
  useEffect(() => {
    if (!similar || similarPicked || !transaction) return;
    const outgoing = transaction.amount < 0;
    setSimilarPicked(new Set(similar.filter((t) => (t.amount < 0) === outgoing).map((t) => t.id)));
  }, [similar, similarPicked, transaction]);
  const pickedCount = applyToSimilar ? similarPicked?.size ?? 0 : 0;

  function togglePicked(id: number) {
    setSimilarPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isDirty =
    description !== (transaction?.description ?? "") ||
    categoryId !== transaction?.category_id ||
    notes !== (transaction?.notes ?? "");
  // Ticking matches is a change too: the open row may already be right.
  const canSave = isDirty || pickedCount > 0;

  const unlinkTransfer = useUnlinkTransfer();
  const isSaving = update.isPending || bulkUpdate.isPending;

  async function handleSave() {
    if (!transaction) return;

    await update.mutateAsync({
      id: transaction.id,
      description,
      category_id: categoryId,
      notes: notes || null,
    });

    // Only the category spreads. Copying the description and notes as well
    // renamed every match to the open row's text.
    if (pickedCount > 0 && similarPicked && categoryId != null) {
      await bulkUpdate.mutateAsync({
        transaction_ids: [...similarPicked],
        category_id: categoryId,
      });
    }

    onClose();
  }

  async function handleDelete() {
    if (!transaction) return;
    await deleteTxn.mutateAsync(transaction.id);
    onClose();
  }

  async function handleToggleDuplicate() {
    if (!transaction) return;
    await markDuplicate.mutateAsync({
      id: transaction.id,
      is_duplicate: !transaction.is_duplicate,
    });
    onClose();
  }

  const drawerTitle = transaction ? (
    <span className="flex items-center gap-2">
      {transaction.is_duplicate && (
        <span className="inline-flex items-center gap-1 text-xs font-normal bg-warning/15 text-warning px-1.5 py-0.5 rounded">
          <Copy size={10} /> DUP
        </span>
      )}
      <MerchantLogo name={transaction.merchant_name || transaction.description} size={24} />
      <span className="truncate" data-private>{transaction.description || "Transaction"}</span>
    </span>
  ) : null;

  return (
    <SideDrawer open={transaction != null} onClose={onClose} title={drawerTitle}>
      {transaction && (
        <div className="flex flex-col gap-5 px-5 py-5">
          {/* Meta row */}
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{formatDate(transaction.date_posted)}</span>
            <span className="flex min-w-0 items-center gap-1.5 font-medium">
              {account && <AccountLogo size="sm" />}
              <span className="truncate">{transaction.account_name}</span>
            </span>
            <span
              className={cn(
                "font-semibold tabular-nums text-sm",
                transaction.amount >= 0 ? "text-success" : "text-destructive"
              )}
            >
              {transaction.amount >= 0 ? "+" : "\u2212"}{formatCurrencyFull(Math.abs(transaction.amount))}
            </span>
          </div>

          <hr className="border-border" />

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Description
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Category */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Category
            </label>
            <CategoryPicker
              value={categoryId}
              onChange={(id) => setCategoryId(id ?? null)}
              variant="full"
            />
          </div>

          {/* Notes */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Add a note…"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground"
            />
          </div>

          {/* Apply to similar: the matches, each with a checkbox */}
          <div className="rounded-lg border border-border">
            <label className="flex items-center gap-2.5 cursor-pointer select-none px-3 py-2.5 text-sm font-medium">
              <input
                type="checkbox"
                checked={applyToSimilar}
                onChange={(e) => setApplyToSimilar(e.target.checked)}
                className="rounded border-border accent-primary"
              />
              Apply the category to similar transactions
            </label>
            {applyToSimilar && (
              similarQuery.isLoading ? (
                <p className="px-3 pb-3 text-xs text-muted-foreground">Finding similar transactions…</p>
              ) : !similar?.length ? (
                <p className="px-3 pb-3 text-xs text-muted-foreground">No similar transactions found.</p>
              ) : (
                <>
                  <div className="flex items-center justify-between px-3 pb-2 text-xs text-muted-foreground">
                    <span>{pickedCount} of {similar.length} selected</span>
                    <span className="flex gap-2">
                      <button type="button" className="text-primary hover:underline"
                        onClick={() => setSimilarPicked(new Set(similar.map((t) => t.id)))}>
                        Select all
                      </button>
                      <button type="button" className="text-primary hover:underline"
                        onClick={() => setSimilarPicked(new Set())}>
                        None
                      </button>
                    </span>
                  </div>
                  <ul className="max-h-64 overflow-y-auto divide-y divide-border border-t border-border">
                    {similar.map((t) => (
                      <li key={t.id}>
                        <label className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5 px-3 py-2 text-sm hover:bg-muted/40">
                          <input
                            type="checkbox"
                            checked={similarPicked?.has(t.id) ?? false}
                            onChange={() => togglePicked(t.id)}
                            className="rounded border-border accent-primary"
                            aria-label={`Include ${t.description ?? "transaction"} on ${formatDate(t.date_posted)}`}
                          />
                          <span className="min-w-0">
                            <span className="block truncate" data-private>{t.description}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {formatDate(t.date_posted)} · <span data-private>{t.account_name}</span> · {t.category_name ?? "Uncategorized"}
                            </span>
                          </span>
                          <span className={cn("tabular-nums", t.amount < 0 ? "text-destructive" : "text-success")} data-private>
                            {t.amount < 0 ? "\u2212" : "+"}{formatCurrencyFull(Math.abs(t.amount))}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                    Only the category changes. Descriptions and notes stay as they are.
                  </p>
                </>
              )
            )}
          </div>

          {/* Save button */}
          <Button
            onClick={handleSave}
            disabled={!canSave || isSaving}
            loading={isSaving}
            className="w-full"
          >
            {pickedCount > 0 ? `Save and update ${pickedCount} more` : "Save changes"}
          </Button>

          <hr className="border-border" />

          {/* Attachments */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Paperclip size={11} />
                Attachments
              </label>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadAtt.isPending}
                className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium transition-colors disabled:opacity-50"
              >
                <FileUp size={12} />
                {uploadAtt.isPending ? "Uploading…" : "Upload"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={RECEIPT_ACCEPT}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file || !transaction) return;
                  const big = tooLarge(file, UPLOAD_LIMITS.receipt, "Each attachment");
                  if (big) {
                    toastError(big);
                    return;
                  }
                  uploadAtt.mutate(
                    { txnId: transaction.id, file },
                    { onError: (err) => toastError((err as Error).message) },
                  );
                }}
              />
            </div>

            {attachments.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No attachments yet. Add a photo or PDF under 5 MB.
              </p>
            ) : (
              <ul className="space-y-1">
                {attachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5"
                  >
                    <Paperclip size={12} className="shrink-0 text-muted-foreground" />
                    {/* A button, not a link: a link sends no access token,
                        so the download route answered 401. */}
                    <button
                      type="button"
                      onClick={() =>
                        api
                          .download(
                            "GET",
                            `/transactions/${transaction!.id}/attachments/${att.id}/download`,
                            undefined,
                            att.filename,
                          )
                          .catch(toastError("Could not download the attachment"))
                      }
                      className="flex-1 min-w-0 text-left text-xs truncate text-primary hover:underline"
                    >
                      {att.filename}
                    </button>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {(att.size_bytes / 1024).toFixed(0)} KB
                    </span>
                    <button
                      onClick={() =>
                        deleteAtt.mutate({ txnId: transaction!.id, attId: att.id })
                      }
                      className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                      aria-label="Delete attachment"
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Paired movement.
              Lives here rather than as a badge on every row: the table is for
              scanning and the Category column already says the money is
              net-worth-neutral. What is not visible anywhere else is *which*
              transaction it was paired with, and — since the matcher confirms
              pairs on its own — that a recategorisation happened without anyone
              approving it. This is the only place to see that and undo it. */}
          {transaction.transfer?.status === "confirmed" && (
            <>
              <hr className="border-border" />
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Paired movement
                </p>
                <div className="rounded-md border border-border bg-muted/30 p-3 space-y-1.5">
                  <p className="text-sm">
                    Counted once, with a transaction in{" "}
                    <span className="font-medium">
                      {transaction.transfer.counterpart_account_name ?? "another account"}
                    </span>
                    .
                  </p>
                  {(transaction.transfer.counterpart_date ||
                    transaction.transfer.counterpart_amount != null) && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {transaction.transfer.counterpart_date}
                      {transaction.transfer.counterpart_amount != null &&
                        ` · ${formatCurrencyFull(Math.abs(transaction.transfer.counterpart_amount))}`}
                      {transaction.transfer.counterpart_description &&
                        ` · ${transaction.transfer.counterpart_description}`}
                    </p>
                  )}
                  {transaction.transfer.source === "auto" && (
                    <p className="text-xs text-muted-foreground">
                      Linked automatically
                      {transaction.transfer.matched_on
                        ? `, matched on ${transaction.transfer.matched_on.replace(/\+/g, ", ")}`
                        : ""}
                      .
                    </p>
                  )}
                </div>
                <button
                  onClick={() => unlinkTransfer.mutate(transaction.transfer!.link_id)}
                  disabled={unlinkTransfer.isPending}
                  className="w-full flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                >
                  {unlinkTransfer.isPending ? "Unlinking…" : "Unlink these transactions"}
                </button>
                <p className="text-xs text-muted-foreground">
                  Unlinking counts both sides separately again. Their categories
                  are left as they are. Change them here if that is wrong.
                </p>
              </div>
            </>
          )}

          <hr className="border-border" />

          {/* Secondary actions */}
          <div className="space-y-2">
            {/* Mark / unmark duplicate */}
            <button
              onClick={handleToggleDuplicate}
              disabled={markDuplicate.isPending}
              className={cn(
                "w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium border transition-colors",
                transaction.is_duplicate
                  ? "border-warning text-warning hover:bg-warning/10"
                  : "border-border text-muted-foreground hover:border-warning hover:text-warning hover:bg-warning/10"
              )}
            >
              <Copy size={13} />
              {transaction.is_duplicate ? "Remove duplicate flag" : "Mark as duplicate"}
            </button>

            {/* Delete */}
            {confirmDelete ? (
              <div className="flex gap-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={handleDelete}
                  loading={deleteTxn.isPending}
                >
                  <AlertTriangle size={13} />
                  Confirm delete
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium border border-border text-muted-foreground hover:border-destructive hover:text-destructive hover:bg-destructive/5 transition-colors"
              >
                <AlertTriangle size={13} />
                Delete transaction
              </button>
            )}
          </div>
        </div>
      )}
    </SideDrawer>
  );
}

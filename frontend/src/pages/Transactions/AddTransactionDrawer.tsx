import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { CategoryPicker } from "@/components/ui/CategoryPicker";
import { toast } from "@/components/ui/toast";
import { useCreateTransaction } from "@/hooks/useTransactions";
import { EARLIEST_DATE, todayIso } from "@/lib/validation";
import { cn } from "@/lib/utils";
import type { Account } from "@/types";
import { MoneyInput } from "@/components/ui/MoneyInput";

const labelCls = "text-xs font-medium text-muted-foreground uppercase tracking-wide";
const inputCls =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60";

type Direction = "out" | "in";

/**
 * One transaction typed in by hand, for an account that is not synced.
 * Basic users keep their accounts by hand, and a single purchase used
 * to need a whole file import. Synced accounts are left out: their rows come
 * from the bank, and the server decides which those are
 * (`can_import_transactions`).
 */
export function AddTransactionDrawer({
  open, onClose, accounts, defaultAccountId,
}: {
  open: boolean;
  onClose: () => void;
  /** Accounts that take hand-entered rows. */
  accounts: Account[];
  /** Preselected, for example the account the table is filtered to. */
  defaultAccountId?: number;
}) {
  const create = useCreateTransaction();
  const [accountId, setAccountId] = useState<number | "">("");
  const [date, setDate] = useState(todayIso());
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [direction, setDirection] = useState<Direction>("out");
  const [categoryId, setCategoryId] = useState<number | null | undefined>(undefined);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    const preset = accounts.find((a) => a.id === defaultAccountId) ?? accounts[0];
    setAccountId(preset?.id ?? "");
    setDate(todayIso());
    setDescription("");
    setAmount("");
    setDirection("out");
    setCategoryId(undefined);
    setTried(false);
    create.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const errors = {
    account: accountId === "" ? "Choose an account." : null,
    date: !date ? "Enter the date." : date > todayIso() ? "The date cannot be in the future." : null,
    description: description.trim() ? null : "Enter a description, for example the shop or payee.",
    amount: amount.trim() !== "" && Number(amount) > 0 ? null : "Enter an amount above $0.",
  };
  const hasErrors = Object.values(errors).some(Boolean);
  const show = (k: keyof typeof errors) => (tried ? errors[k] : null);

  async function save() {
    setTried(true);
    if (hasErrors || accountId === "") return;
    const value = Math.abs(Number(amount));
    try {
      await create.mutateAsync({
        account_id: accountId,
        date_posted: date,
        description: description.trim(),
        amount: direction === "out" ? -value : value,
        transaction_type: direction === "out" ? "debit" : "credit",
        ...(categoryId ? { category_id: categoryId } : {}),
      });
    } catch {
      return; // shown under the form from create.error
    }
    toast("Transaction added.", { variant: "success" });
    onClose();
  }

  return (
    <SideDrawer open={open} onClose={onClose} title="Add transaction">
      <form
        noValidate
        onSubmit={(e) => { e.preventDefault(); void save(); }}
        className="px-5 py-5 space-y-4"
      >
        <div className="space-y-1.5">
          <label htmlFor="add-txn-account" className={labelCls}>Account</label>
          <select
            id="add-txn-account"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}
            className={cn(inputCls, show("account") && "border-destructive")}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.display_name}</option>
            ))}
          </select>
          {show("account") && <p className="text-xs text-destructive">{show("account")}</p>}
        </div>

        <div className="space-y-1.5">
          <span className={labelCls}>Type</span>
          {/* Money in or out, said in words rather than by the sign of the
              number, which is easy to get backwards. */}
          <div role="radiogroup" aria-label="Money in or out" className="grid grid-cols-2 gap-2">
            {(["out", "in"] as const).map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={direction === d}
                onClick={() => setDirection(d)}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                  direction === d
                    ? "border-primary bg-primary/5 text-foreground ring-2 ring-primary/30"
                    : "border-border text-muted-foreground hover:bg-muted/50",
                )}
              >
                {d === "out" ? "Money out" : "Money in"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="add-txn-date" className={labelCls}>Date</label>
            <input
              id="add-txn-date"
              type="date"
              min={EARLIEST_DATE}
              max={todayIso()}
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-invalid={show("date") ? true : undefined}
              className={cn(inputCls, show("date") && "border-destructive")}
            />
            {show("date") && <p className="text-xs text-destructive">{show("date")}</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="add-txn-amount" className={labelCls}>Amount ($)</label>
            <MoneyInput
              id="add-txn-amount"
              allowNegative={false}
              placeholder="0.00"
              value={amount}
              onValueChange={setAmount}
              aria-invalid={show("amount") ? true : undefined}
              className={cn(inputCls, "text-right tabular-nums", show("amount") && "border-destructive")}
            />
            {show("amount") && <p className="text-xs text-destructive">{show("amount")}</p>}
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="add-txn-desc" className={labelCls}>Description</label>
          <input
            id="add-txn-desc"
            type="text"
            maxLength={200}
            placeholder="e.g. Corner Grocery"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-invalid={show("description") ? true : undefined}
            className={cn(inputCls, show("description") && "border-destructive")}
          />
          {show("description") && <p className="text-xs text-destructive">{show("description")}</p>}
        </div>

        <div className="space-y-1.5">
          <span className={labelCls}>
            Category <span className="normal-case font-normal text-muted-foreground/60">(optional, filled in for you if left blank)</span>
          </span>
          <CategoryPicker value={categoryId} onChange={setCategoryId} variant="full" />
        </div>

        {create.error && (
          <p role="alert" className="text-xs text-destructive">{(create.error as Error).message}</p>
        )}
        <Button type="submit" loading={create.isPending} className="w-full">
          Add transaction
        </Button>
      </form>
    </SideDrawer>
  );
}

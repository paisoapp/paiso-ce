import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Building2, Trash2, Plus, Search, Upload, X } from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui/dialog";
import { SideDrawer } from "@/components/ui/SideDrawer";
import { AddAccountDialog } from "./AddAccountDialog";
import { CsvImportWizard } from "./CsvImportWizard";
import { AccountBalanceChart, BalanceSparkline, useAccountSparklines, type BalancePoint } from "./AccountBalanceCharts";
import { LiabilityDetail } from "./LiabilityDetail";
import { useAccounts, useDeleteAccount, useUpdateAccount } from "@/hooks/useAccounts";
import { useDebounce } from "@/hooks/useDebounce";
import { cn, formatCurrency } from "@/lib/utils";
import type { Account } from "@/types";
import { ACCOUNT_NAME_MAX } from "@/lib/validation";
import { AccountTypeFields, choiceFor, choiceIsComplete, type TypeChoice } from "./AccountKindFields";
import { MoneyInput } from "@/components/ui/MoneyInput";

const ACCOUNT_TYPES = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "credit_card", label: "Credit Card" },
  { value: "brokerage", label: "Brokerage" },
  { value: "hsa", label: "HSA" },
  { value: "529", label: "529 Plan" },
  { value: "401k", label: "401(k)" },
  { value: "ira", label: "IRA" },
  { value: "roth_ira", label: "Roth IRA" },
  { value: "loan", label: "Loan" },
  { value: "mortgage", label: "Mortgage" },
  { value: "other", label: "Other" },
];

const TYPE_LABEL: Record<string, string> = Object.fromEntries(
  ACCOUNT_TYPES.map(({ value, label }) => [value, label])
);

// Light per-type accent so account kinds are distinguishable at a glance.
// Full literal class strings so Tailwind's JIT keeps them.
type TypeStyle = { tile: string; text: string };
const TYPE_STYLE: Record<string, TypeStyle> = {
  checking:    { tile: "bg-blue-500/10",    text: "text-blue-600" },
  savings:     { tile: "bg-emerald-500/10", text: "text-emerald-600" },
  credit_card: { tile: "bg-rose-500/10",    text: "text-rose-600" },
  brokerage:   { tile: "bg-violet-500/10",  text: "text-violet-600" },
  hsa:         { tile: "bg-teal-500/10",    text: "text-teal-600" },
  "529":       { tile: "bg-amber-500/10",   text: "text-amber-600" },
  "401k":      { tile: "bg-indigo-500/10",  text: "text-indigo-600" },
  ira:         { tile: "bg-purple-500/10",  text: "text-purple-600" },
  roth_ira:    { tile: "bg-fuchsia-500/10", text: "text-fuchsia-600" },
  loan:        { tile: "bg-orange-500/10",  text: "text-orange-600" },
  mortgage:    { tile: "bg-orange-500/10",  text: "text-orange-600" },
  other:       { tile: "bg-muted",          text: "text-muted-foreground" },
};
export const typeStyle = (t: string): TypeStyle => TYPE_STYLE[t] ?? TYPE_STYLE.other;

// Short, human-friendly "last updated" label from a YYYY-MM-DD balance date.
function formatLastUpdated(d: string | null): string {
  if (!d) return "—";
  const then = new Date(`${d}T00:00:00`);
  if (Number.isNaN(then.getTime())) return "—";
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// AccountLogo — square tile with a bank glyph, in the account type's colours
// ---------------------------------------------------------------------------

export function AccountLogo({
  size = "md",
  accent,
}: {
  size?: "sm" | "md" | "lg";
  accent?: TypeStyle;
}) {
  const box =
    size === "lg" ? "h-[70px] w-[70px] rounded-xl"
    : size === "sm" ? "h-6 w-6 rounded-md"
    : "h-[55px] w-[55px] rounded-xl";
  const glyph = size === "lg" ? 28 : size === "sm" ? 14 : 25;
  return (
    <div
      className={cn(
        "shrink-0 flex items-center justify-center overflow-hidden border border-border",
        box,
        accent?.tile ?? "bg-muted"
      )}
    >
      <Building2 size={glyph} className={accent?.text ?? "text-muted-foreground"} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AccountCard — one account in the grid
// ---------------------------------------------------------------------------
// Four facts, in the order they get read: what it is, what kind, how much,
// how fresh. The type used to sit in its own bordered tile alongside two more;
// three boxes per card times thirty-odd cards was most of what made the page
// look busy, so the type is a pill and the numbers carry themselves.

const DEBT_ACCOUNT_TYPES = new Set(["credit_card", "loan", "mortgage"]);

const ROUND_ICON_BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted-foreground " +
  "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent";

function AccountCard({
  acct,
  showInstitution,
  spark,
  onEdit,
  onImportCsv,
}: {
  acct: Account;
  /** False inside an institution group, where the header already says it. */
  showInstitution: boolean;
  /** The last three months of this account's balance. */
  spark: BalancePoint[] | undefined;
  onEdit: () => void;
  onImportCsv: () => void;
}) {
  const balance =
    acct.current_balance != null ? formatCurrency(acct.current_balance, acct.currency) : "—";
  const style = typeStyle(acct.account_type);
  const freshness = `Updated ${formatLastUpdated(acct.balance_as_of)}`;

  return (
    <div
      onClick={onEdit}
      className="group flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 cursor-pointer shadow-sm hover:border-border/70 hover:shadow-md transition-all focus-within:ring-2 focus-within:ring-primary/50"
    >
      <div className="flex items-start gap-3 min-w-0">
        <AccountLogo accent={style} />
        <div className="min-w-0 flex-1">
          {/* The name is the card's keyboard target: the card itself is a
              click area, which Tab used to skip entirely. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            title={acct.display_name}
            aria-label={`${acct.display_name}, ${balance}. Open details`}
            className="block w-full text-left font-semibold leading-tight truncate focus:outline-none"
            data-private
          >
            {acct.display_name}
          </button>
          <div className="mt-1.5 flex items-center gap-1.5 min-w-0">
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                style.tile,
                style.text,
              )}
            >
              {acct.subtype_label ?? TYPE_LABEL[acct.account_type] ?? acct.account_type}
            </span>
            {showInstitution && acct.institution_name && (
              <span className="text-xs text-muted-foreground truncate">
                {acct.institution_name}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* mt-auto so the numbers line up across a row of cards whose headers
          wrap to different heights. The last three months sit quietly above
          the figure they lead up to. */}
      <div className="mt-auto">
        <BalanceSparkline points={spark} owed={DEBT_ACCOUNT_TYPES.has(acct.account_type)} />
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="min-w-0 truncate text-lg font-semibold tabular-nums leading-none">{balance}</p>
        <p className="text-xs text-muted-foreground shrink-0 leading-none">{freshness}</p>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); onImportCsv(); }}
        className="flex items-center justify-center gap-2 w-full rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      >
        <Upload size={14} />
        Import a file
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// AccountEditDrawer
// ---------------------------------------------------------------------------

function AccountEditDrawer({
  account,
  onClose,
  onImportCsv,
}: {
  account: Account | null;
  onClose: () => void;
  onImportCsv: (acct: Account) => void;
}) {
  const update = useUpdateAccount();
  const deleteAccount = useDeleteAccount();
  const [name, setName] = useState(account?.display_name ?? "");
  // Type, and for an investment account its sub-type; account_type follows.
  const [choice, setChoice] = useState<TypeChoice>(choiceFor(account));
  const accountType = choice.accountType;
  const [institution, setInstitution] = useState(account?.institution_name ?? "");
  const [balanceStr, setBalanceStr] = useState(account?.current_balance?.toString() ?? "");
  const [creditLimitStr, setCreditLimitStr] = useState(account?.credit_limit?.toString() ?? "");
  const [descriptionPattern, setDescriptionPattern] = useState(account?.description_pattern ?? "");
  const [confirmDelete, setConfirmDelete] = useState(false);
  // For a mortgage behind a property: delete the property too, or keep it as
  // owned outright. The loan goes with the account either way.
  const [deleteProperty, setDeleteProperty] = useState(false);
  // Save stays enabled once something changed, and says what is wrong.
  const [tried, setTried] = useState(false);
  const navigate = useNavigate();

  const acctId = account?.id;
  useEffect(() => {
    if (account) {
      setName(account.display_name);
      setChoice(choiceFor(account));
      setInstitution(account.institution_name ?? "");
      setBalanceStr(account.current_balance?.toString() ?? "");
      setCreditLimitStr(account.credit_limit?.toString() ?? "");
      setDescriptionPattern(account.description_pattern ?? "");
      setConfirmDelete(false);
      setDeleteProperty(false);
      setTried(false);
    }
  }, [acctId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!account) return null;

  const isMortgage = account.account_type === "mortgage";
  const initChoice = choiceFor(account);
  const classificationChanged =
    choice.investmentType !== initChoice.investmentType || choice.subtype !== initChoice.subtype;

  const isDirty =
    name.trim() !== account.display_name ||
    accountType !== account.account_type ||
    institution !== (account.institution_name ?? "") ||
    balanceStr !== (account.current_balance?.toString() ?? "") ||
    creditLimitStr !== (account.credit_limit?.toString() ?? "") ||
    descriptionPattern !== (account.description_pattern ?? "") ||
    classificationChanged;

  const nameError = name.trim() ? null : "Enter a name for this account.";
  const typeError = choiceIsComplete(choice) ? null : "Choose the kind of investment account.";

  async function handleSave() {
    if (!account) return;
    setTried(true);
    if (nameError || typeError) return;

    const initBalance = account.current_balance?.toString() ?? "";
    const initCreditLimit = account.credit_limit?.toString() ?? "";
    const balanceChanged = balanceStr !== initBalance;
    const creditLimitChanged = creditLimitStr !== initCreditLimit;
    const patternChanged = descriptionPattern !== (account.description_pattern ?? "");
    const parsedBalance = balanceStr.trim() !== "" ? parseFloat(balanceStr) : null;
    const parsedCreditLimit = creditLimitStr.trim() !== "" ? parseFloat(creditLimitStr) : null;

    await update.mutateAsync({
      id: account.id,
      ...(name.trim() !== account.display_name ? { display_name: name.trim() } : {}),
      // An investment account's account_type follows its sub-type on the
      // server; only a plain type change sends account_type itself.
      ...(accountType !== account.account_type && !choice.investmentType ? { account_type: accountType } : {}),
      ...(institution !== (account.institution_name ?? "") ? { institution_name: institution } : {}),
      ...(balanceChanged ? { current_balance: parsedBalance } : {}),
      ...(creditLimitChanged ? { credit_limit: parsedCreditLimit } : {}),
      ...(patternChanged ? { description_pattern: descriptionPattern.trim() || null } : {}),
      ...(classificationChanged && choice.investmentType
        ? { investment_type: choice.investmentType, subtype: choice.subtype } : {}),
    });
    onClose();
  }

  async function handleDelete() {
    if (!account) return;
    await deleteAccount.mutateAsync({ id: account.id, deleteProperty });
    onClose();
  }

  return (
    <SideDrawer open={account != null} onClose={onClose} title={account.display_name}>
      <div className="flex flex-col gap-5 px-5 py-5">

        {/* The account's tile and its institution. */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <AccountLogo size="lg" accent={typeStyle(accountType)} />
            <p className="min-w-0 truncate text-sm font-medium">
              {institution.trim() || account.display_name}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            aria-label={`Delete ${account.display_name}`}
            title="Delete this account"
            className={cn(ROUND_ICON_BUTTON, "shrink-0 hover:border-destructive hover:text-destructive hover:bg-destructive/5")}
          >
            <Trash2 size={15} />
          </button>
          </div>

        </div>

        <AccountBalanceChart
          accountId={account.id}
          owed={DEBT_ACCOUNT_TYPES.has(account.account_type)}
          currency={account.currency}
        />

        <hr className="border-border" />

        {/* Account name */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Account Name
          </label>
          <input
            type="text"
            value={name}
            maxLength={ACCOUNT_NAME_MAX}
            aria-label="Account name"
            aria-invalid={tried && nameError ? true : undefined}
            onChange={(e) => setName(e.target.value)}
            className={cn(
              "w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50",
              tried && nameError && "border-destructive",
            )}
          />
          {tried && nameError && <p className="text-xs text-destructive">{nameError}</p>}
        </div>

        {/* Account type, then a sub-type for an investment account. */}
        <AccountTypeFields value={choice} onChange={setChoice} />
        {tried && typeError && <p className="-mt-3 text-xs text-destructive">{typeError}</p>}

        {/* Institution */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Institution
          </label>
          <input
            type="text"
            value={institution}
            onChange={(e) => setInstitution(e.target.value)}
            placeholder="e.g. Chase Bank"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Mortgage: ACH pattern + linked property info */}
        {isMortgage ? (
          <div className="space-y-4">
            {account.linked_asset_id ? (
              <div className="rounded-md bg-muted/40 border border-border px-3 py-2.5 space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Linked Property</p>
                <p className="text-xs text-muted-foreground">
                  This mortgage belongs to a property. Its debt is counted once, through the property.{" "}
                  <button
                    type="button"
                    onClick={() => { onClose(); navigate(`/investments/property?asset=${account.linked_asset_id}`); }}
                    className="font-medium text-primary hover:underline"
                  >
                    Edit the property and loan
                  </button>
                </p>
              </div>
            ) : (
              <div className="rounded-md bg-warning/10 border border-warning/30 px-3 py-2.5">
                <p className="text-xs font-medium text-warning">No linked property</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  This mortgage is counted in your debt on its own. To track the home it pays for, choose{" "}
                  <button
                    type="button"
                    onClick={() => { onClose(); navigate("/investments/property?add=mortgage"); }}
                    className="font-medium text-primary hover:underline"
                  >
                    Add property
                  </button>{" "}
                  and pick this mortgage.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                ACH Description Pattern{" "}
                <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
              </label>
              <p className="text-xs text-muted-foreground/70">
                Text matched against checking transactions to show mortgage payments in the Mortgage tab. Update this if your servicer's ACH description changes.
              </p>
              <input
                type="text"
                value={descriptionPattern}
                onChange={(e) => setDescriptionPattern(e.target.value)}
                placeholder="e.g. JPMORGAN CHASE"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              />
            </div>
          </div>
        ) : (
          <>
            {/* Current Balance */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Current Balance{" "}
                <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
              </label>
              {accountType === "credit_card" && (
                <p className="text-xs text-muted-foreground/70">Enter the amount currently owed on this card.</p>
              )}
              <MoneyInput
                value={balanceStr}
                onValueChange={setBalanceStr}
                placeholder="0.00"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
              />
            </div>

            {/* Credit Limit — credit cards only */}
            {accountType === "credit_card" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Credit Limit{" "}
                  <span className="normal-case font-normal text-muted-foreground/60">(optional)</span>
                </label>
                <MoneyInput
                  allowNegative={false}
                  value={creditLimitStr}
                  onValueChange={setCreditLimitStr}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                />
              </div>
            )}
          </>
        )}

        {/* Loan & payment detail, entered by hand */}
        {account?.liability && <LiabilityDetail liability={account.liability} />}

        {/* Save */}
        {update.error && (
          <p role="alert" className="text-xs text-destructive">{(update.error as Error).message}</p>
        )}
        <Button
          onClick={handleSave}
          disabled={!isDirty || update.isPending}
          loading={update.isPending}
          className="w-full"
          title={isDirty ? undefined : "Nothing has changed yet"}
        >
          Save changes
        </Button>

        <hr className="border-border" />
        <button
          onClick={() => { onClose(); onImportCsv(account); }}
          className="flex items-center justify-center gap-2 w-full rounded-md border border-border px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <Upload size={14} />
          Import a file
        </button>
      </div>

      {confirmDelete && (
        <Dialog open onClose={() => setConfirmDelete(false)} className="md:max-w-md">
          <DialogHeader onClose={() => setConfirmDelete(false)}>Delete {account.display_name}?</DialogHeader>
          <DialogBody className="text-sm">
            <p>This deletes the account and everything in it. This cannot be undone.</p>
            {account.linked_asset_id != null && (
              <fieldset className="mt-4 space-y-2">
                <legend className="font-medium">This mortgage belongs to a property. What should happen to it?</legend>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="property" checked={!deleteProperty} onChange={() => setDeleteProperty(false)} className="mt-1 accent-primary" />
                  <span>Keep the property, owned outright. Its loan is removed.</span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input type="radio" name="property" checked={deleteProperty} onChange={() => setDeleteProperty(true)} className="mt-1 accent-primary" />
                  <span>Delete the property as well.</span>
                </label>
              </fieldset>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={deleteAccount.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} loading={deleteAccount.isPending}>
              Delete account and history
            </Button>
          </DialogFooter>
        </Dialog>
      )}
    </SideDrawer>
  );
}

// ---------------------------------------------------------------------------
// AccountList
// ---------------------------------------------------------------------------

/** How the grid is arranged: by institution (the default), by account type,
 *  or as one flat list by name or by balance. */
type View = "institution" | "type" | "name" | "balance";

const VIEW_LABELS: Record<View, string> = {
  institution: "Group by institution",
  type: "Group by account type",
  name: "All accounts, A–Z",
  balance: "All accounts, by balance",
};

const byName = (a: Account, b: Account) =>
  (a.display_name ?? "").localeCompare(b.display_name ?? "");

/** One rendered block of the grid. */
type Group = {
  key: string;
  /** null in the flat views, which render a single unlabelled grid. */
  label: string | null;
  /** The institution to resolve a logo from; null when the group is not one. */
  institutionName: string | null;
  accounts: Account[];
};

function push(buckets: Map<string, Account[]>, key: string, a: Account): void {
  const list = buckets.get(key);
  if (list) list.push(a);
  else buckets.set(key, [a]);
}

function buildGroups(accounts: Account[], view: View): Group[] {
  if (view === "name" || view === "balance") {
    const sorted = [...accounts].sort(
      view === "balance"
        ? (a, b) =>
            (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0) ||
            byName(a, b)
        : byName,
    );
    return [{ key: "all", label: null, institutionName: null, accounts: sorted }];
  }

  if (view === "type") {
    const rank = new Map(ACCOUNT_TYPES.map((t, i) => [t.value, i]));
    const buckets = new Map<string, Account[]>();
    for (const a of accounts) push(buckets, a.account_type || "other", a);
    return [...buckets.entries()]
      .sort(([a], [b]) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99) || a.localeCompare(b))
      .map(([type, list]) => ({
        key: `type:${type}`,
        label: TYPE_LABEL[type] ?? type,
        institutionName: null,
        accounts: [...list].sort(byName),
      }));
  }

  // Grouped by institution name; accounts with none come last.
  const buckets = new Map<string, Account[]>();
  for (const a of accounts) {
    const named = a.institution_name?.trim();
    push(buckets, named ? `inst:${named.toLowerCase()}` : "none", a);
  }
  return [...buckets.entries()]
    .map(([key, list]) => {
      const name = key === "none" ? null : list[0].institution_name?.trim() ?? null;
      return {
        key,
        label: name ?? "No institution",
        institutionName: name,
        accounts: [...list].sort(byName),
        rank: key === "none" ? 1 : 0,
      };
    })
    .sort((a, b) => a.rank - b.rank || (a.label ?? "").localeCompare(b.label ?? ""))
    .map(({ rank: _rank, ...group }) => group);
}

/** One institution (or account type) above its cards. */
function GroupHeader({ group }: { group: Group }) {
  const n = group.accounts.length;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border pb-2">
      {group.institutionName && <AccountLogo size="sm" />}
      <h3 className="text-sm font-semibold">{group.label}</h3>
      <p className="text-xs text-muted-foreground">
        {n} account{n === 1 ? "" : "s"}
      </p>
    </div>
  );
}

export function AccountList() {
  const { data: accounts = [], isLoading } = useAccounts();

  const [showAdd, setShowAdd] = useState(false);
  // /settings?add=1 opens the add-account drawer on arrival. The setup guide's
  // "Add liabilities" step used to land here and leave the person to find the
  // button. The parameter is dropped at once so a reload does not reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get("add") !== "1") return;
    setShowAdd(true);
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  const [importingAccount, setImportingAccount] = useState<Account | null>(null);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);

  const [rawQuery, setRawQuery] = useState("");
  const query = useDebounce(rawQuery, 200);
  const [view, setView] = useState<View>("institution");

  // Search covers institution *and* account name — someone looking for "chase"
  // means either, and making them guess which field is searched is a papercut.
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter(
      (a) =>
        (a.institution_name ?? "").toLowerCase().includes(needle) ||
        (a.display_name ?? "").toLowerCase().includes(needle) ||
        (a.account_type ?? "").toLowerCase().includes(needle),
    );
  }, [accounts, query]);

  const groups = useMemo(() => buildGroups(visible, view), [visible, view]);
  const { data: sparklines } = useAccountSparklines();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Accounts</h2>
          <p className="text-sm text-muted-foreground">
            {accounts.length} account{accounts.length === 1 ? "" : "s"}. Add them yourself or import a file
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} />
            Add manually
          </Button>
        </div>
      </div>
      {/* Search + arrangement. Hidden while empty so a new user isn't asked to
          filter a list of nothing. */}
      {accounts.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search
              size={14}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
            />
            <input
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search institution or account…"
              aria-label="Search accounts"
              className="w-full rounded-md border border-border bg-background pl-8 pr-8 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
            />
            {rawQuery && (
              <button
                onClick={() => setRawQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={13} />
              </button>
            )}
          </div>
          <select
            value={view}
            onChange={(e) => setView(e.target.value as View)}
            aria-label="Arrange accounts"
            className="rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 sm:w-56"
          >
            {(Object.keys(VIEW_LABELS) as View[]).map((key) => (
              <option key={key} value={key}>{VIEW_LABELS[key]}</option>
            ))}
          </select>
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-36 rounded-2xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-16 text-center">
          <p className="font-medium">No accounts yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Add an account to start tracking your finances.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" onClick={() => setShowAdd(true)}>
              <Plus size={14} />
              Add manually
            </Button>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-12 text-center">
          <p className="text-sm font-medium">No accounts match “{query.trim()}”</p>
          <button
            onClick={() => setRawQuery("")}
            className="mt-2 text-sm text-primary hover:underline"
          >
            Clear search
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <div key={group.key} className="space-y-3">
              {group.label && <GroupHeader group={group} />}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {group.accounts.map((acct) => (
                  <AccountCard
                    key={acct.id}
                    acct={acct}
                    showInstitution={view !== "institution"}
                    spark={sparklines?.series[String(acct.id)]}
                    onEdit={() => setEditingAccount(acct)}
                    onImportCsv={() => setImportingAccount(acct)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <AddAccountDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onImportCsv={(acct) => setImportingAccount(acct)}
      />

      {importingAccount && (
        <CsvImportWizard
          open={!!importingAccount}
          onClose={() => setImportingAccount(null)}
          accountId={importingAccount.id}
          accountName={importingAccount.display_name}
        />
      )}

      <AccountEditDrawer
        account={editingAccount}
        onClose={() => setEditingAccount(null)}
        onImportCsv={(acct) => { setEditingAccount(null); setImportingAccount(acct); }}
      />
    </div>
  );
}

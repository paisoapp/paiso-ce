import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Search, ChevronUp, ChevronDown, ChevronsUpDown,
  ChevronLeft, ChevronRight,
  Plus, SlidersHorizontal, Upload, X,
} from "@/lib/icons";
import { Button } from "@/components/ui/button";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { CategoryPicker } from "@/components/ui/CategoryPicker";
import { MerchantLogo } from "@/components/ui/MerchantLogo";
import { CategoryIcon } from "@/lib/categoryIcons";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { TransactionDrawer } from "./TransactionDrawer";
import { TransactionBreakdown } from "./TransactionBreakdown";
import { AddTransactionDrawer } from "./AddTransactionDrawer";
import { CsvImportWizard } from "@/components/accounts/CsvImportWizard";
import { FeatureTip } from "@/components/onboarding/FeatureTip";
import { useAccounts } from "@/hooks/useAccounts";
import { useCategories, useCategoryIcon } from "@/hooks/useCategories";
import {
  useTransactions,
  useDeleteTransaction,
  useBulkUpdateTransactions,
  type TransactionFilters,
} from "@/hooks/useTransactions";
import { useDebounce } from "@/hooks/useDebounce";
import { useIsMobile } from "@/hooks/useMediaQuery";
import { cn, formatCurrencyFull } from "@/lib/utils";
import { useTransactionDateRange } from "./transactionContext";
import { useUiPrefsStore } from "@/store/uiPrefs";
import type { AccountTypeGroup, Transaction } from "@/types";
import { formatDate } from "@/lib/dates";

/** "+$12.00" / "−$12.00": the direction in the text, not only its colour. */
function signedAmount(amount: number): string {
  return `${amount >= 0 ? "+" : "\u2212"}${formatCurrencyFull(Math.abs(amount))}`;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCOUNT_TYPE_GROUPS: Record<string, string[]> = {
  cash: ["checking", "savings"],
  investments: ["brokerage", "401k", "ira", "roth_ira", "hsa", "529"],
  credit_cards: ["credit_card"],
  loan: ["loan"],
  mortgage: ["mortgage"],
};

const PAGE_SIZES = [10, 20, 50, 100] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SortHeader
// ---------------------------------------------------------------------------

function SortHeader({
  col,
  label,
  sortBy,
  sortOrder,
  onSort,
  className,
}: {
  col: string;
  label: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onSort: (col: string) => void;
  className?: string;
}) {
  const isActive = sortBy === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={cn(
        "px-4 py-2.5 text-left font-medium text-muted-foreground select-none cursor-pointer",
        "hover:text-foreground transition-colors whitespace-nowrap",
        className
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={cn("opacity-50", isActive && "opacity-100 text-primary")}>
          {isActive ? (
            sortOrder === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
          ) : (
            <ChevronsUpDown size={12} />
          )}
        </span>
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// BulkActionBar
// ---------------------------------------------------------------------------

function BulkActionBar({
  count,
  onApply,
  onDelete,
  onClear,
}: {
  count: number;
  onApply: (updates: { category_id?: number | null; description?: string; notes?: string }) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [categoryId, setCategoryId] = useState<number | null | undefined>(undefined);
  const [description, setDescription] = useState("");
  const [notes, setNotes] = useState("");

  const hasChanges = categoryId !== undefined || description.trim() || notes.trim();

  function handleApply() {
    const updates: { category_id?: number | null; description?: string; notes?: string } = {};
    if (categoryId !== undefined) updates.category_id = categoryId;
    if (description.trim()) updates.description = description.trim();
    if (notes.trim()) updates.notes = notes.trim();
    onApply(updates);
    setCategoryId(undefined);
    setDescription("");
    setNotes("");
  }

  return (
    <div className="rounded-lg bg-primary/10 border border-primary/20 px-4 py-3 text-sm space-y-3">
      <div className="flex items-center justify-between">
        <span className="font-semibold text-primary">{count} selected</span>
        <button
          className="text-xs text-muted-foreground underline hover:text-foreground"
          onClick={onClear}
        >
          Clear selection
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {/* Category */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Category</label>
          <CategoryPicker
            value={categoryId}
            onChange={setCategoryId}
            variant="full"
            allowUnchanged
          />
        </div>

        {/* Description */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Description (overwrites all)</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Leave blank to keep existing"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
          />
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Notes (overwrites all)</label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Leave blank to keep existing"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted-foreground/60"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={handleApply}
          disabled={!hasChanges}
        >
          Apply to {count} transaction{count !== 1 ? "s" : ""}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            if (window.confirm(`Delete ${count} transaction(s)? This cannot be undone.`))
              onDelete();
          }}
        >
          Delete selected
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransactionRow
// ---------------------------------------------------------------------------

function TransactionRow({
  txn,
  bulkEditMode,
  selected,
  onSelect,
  onRowClick,
  showMemberName,
}: {
  txn: Transaction;
  bulkEditMode: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
  onRowClick: (txn: Transaction) => void;
  showMemberName: boolean;
}) {
  const categoryIcon = useCategoryIcon(txn.category_id);
  return (
    <tr
      onClick={() => onRowClick(txn)}
      className={cn(
        "border-b border-border/50 transition-colors cursor-pointer",
        "hover:bg-muted/30",
        txn.is_duplicate && "opacity-60",
        txn.pending && "opacity-70",
      )}
    >
      {/* Checkbox — only visible in bulk edit mode */}
      {bulkEditMode && (
        <td className="pl-4 pr-2 py-2.5 w-8" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(txn.id)}
            className="rounded border-border accent-primary cursor-pointer"
          />
        </td>
      )}

      {/* Date */}
      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap text-sm">
        {formatDate(txn.date_posted)}
      </td>

      {/* Account */}
      <td className="px-4 py-2.5 text-muted-foreground whitespace-nowrap text-sm max-w-[140px]">
        <span className="truncate block" title={txn.account_name ?? undefined} data-private>{txn.account_name}</span>
      </td>

      {/* Card Member — Credit Cards tab only (3rd column position) */}
      {showMemberName && (
        <td className="px-4 py-2.5 text-sm text-muted-foreground whitespace-nowrap">
          {txn.member_name ?? "—"}
        </td>
      )}

      {/* Description + duplicate badge */}
      <td className="px-4 py-2.5 text-sm max-w-xs">
        <div className="flex items-center gap-1.5">
          {txn.is_duplicate && (
            <span className="shrink-0 text-[10px] font-semibold bg-warning/15 text-warning px-1 py-0.5 rounded">
              DUP
            </span>
          )}
          {txn.pending && (
            <span
              title="Not yet settled at the bank. Excluded from budgets and net worth"
              className="shrink-0 text-[10px] font-semibold bg-muted text-muted-foreground px-1 py-0.5 rounded"
            >
              PENDING
            </span>
          )}
          <MerchantLogo name={txn.merchant_name || txn.description} />
          <span className="truncate" data-private>{txn.description}</span>
        </div>
      </td>

      {/* Category */}
      <td className="px-4 py-2.5 text-sm">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CategoryIcon
            name={txn.category_name ?? "Uncategorized"}
            icon={categoryIcon}
            className="shrink-0 opacity-70"
          />
          {txn.category_name ?? (
            <span className="italic text-muted-foreground/60">Uncategorized</span>
          )}
        </span>
      </td>

      {/* Amount */}
      <td
        className={cn(
          "px-4 py-2.5 text-right font-medium tabular-nums whitespace-nowrap text-sm",
          txn.amount >= 0 ? "text-success" : "text-destructive"
        )}
      >
        {signedAmount(txn.amount)}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// TransactionCard — mobile list row (rendered instead of the table below md)
// ---------------------------------------------------------------------------

function TransactionCard({
  txn,
  bulkEditMode,
  selected,
  onSelect,
  onRowClick,
  showMemberName,
}: {
  txn: Transaction;
  bulkEditMode: boolean;
  selected: boolean;
  onSelect: (id: number) => void;
  onRowClick: (txn: Transaction) => void;
  showMemberName: boolean;
}) {
  const categoryIcon = useCategoryIcon(txn.category_id);
  const subtitle = [
    formatDate(txn.date_posted),
    txn.account_name,
    showMemberName ? txn.member_name : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      onClick={() => (bulkEditMode ? onSelect(txn.id) : onRowClick(txn))}
      className={cn(
        "flex items-center gap-3 px-4 py-3 cursor-pointer active:bg-muted/30 transition-colors",
        txn.is_duplicate && "opacity-60",
        txn.pending && "opacity-70",
        selected && "bg-primary/5",
      )}
    >
      {bulkEditMode && (
        <input
          type="checkbox"
          checked={selected}
          readOnly
          className="h-4 w-4 shrink-0 rounded border-border accent-primary pointer-events-none"
        />
      )}
      <MerchantLogo name={txn.merchant_name || txn.description} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {txn.is_duplicate && (
            <span className="shrink-0 text-[10px] font-semibold bg-warning/15 text-warning px-1 py-0.5 rounded">
              DUP
            </span>
          )}
          {txn.pending && (
            <span
              title="Not yet settled at the bank. Excluded from budgets and net worth"
              className="shrink-0 text-[10px] font-semibold bg-muted text-muted-foreground px-1 py-0.5 rounded"
            >
              PENDING
            </span>
          )}
          <span className="text-sm font-medium truncate" data-private>{txn.description || "—"}</span>
        </div>
        <p className="text-xs text-muted-foreground truncate mt-0.5" data-private>{subtitle}</p>
      </div>
      <div className="shrink-0 text-right">
        <p
          className={cn(
            "text-sm font-medium tabular-nums",
            txn.amount >= 0 ? "text-success" : "text-destructive",
          )}
        >
          {signedAmount(txn.amount)}
        </p>
        <p className="flex items-center justify-end gap-1 text-[11px] text-muted-foreground max-w-[110px]">
          <CategoryIcon
            name={txn.category_name ?? "Uncategorized"}
            icon={categoryIcon}
            size={11}
            className="shrink-0 opacity-70"
          />
          <span className="truncate">{txn.category_name ?? "Uncategorized"}</span>
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TransactionTable (main export)
// ---------------------------------------------------------------------------

interface TransactionTableProps {
  accountTypeGroup?: AccountTypeGroup;
  showMemberName?: boolean;
  excludeTransfers?: boolean;
  /** Filters pinned from a parent page (date, account, amount_sign).
   *  These are merged into every query and their UI controls are hidden in the toolbar. */
  externalFilters?: Partial<TransactionFilters>;
  /** Charts of how the filtered rows split by account type / account.
   *  On for the Transactions section; Budgeting reuses this table without it. */
  showBreakdown?: boolean;
  /** Section heading for this tab. Set on the Transactions section, where the
   *  table is the page; omitted where Budgeting embeds it under its own
   *  heading. Its presence is what draws the header row that carries the date
   *  range and account controls. */
  title?: string;
  /** In a narrow container such as a side drawer: the card list, as on a
   *  phone, so the amount is never cut off behind a sideways scroll. */
  compact?: boolean;
  /** In the card list, a heading row each time the month changes, with that
   *  month's total from `monthTotals` ("YYYY-MM" keys)
   *  when given: the page holds only some of a month's rows. */
  groupByMonth?: boolean;
  monthTotals?: Record<string, number>;
}

export function TransactionTable({
  accountTypeGroup,
  showMemberName = false,
  excludeTransfers = false,
  externalFilters,
  showBreakdown = false,
  title,
  compact = false,
  groupByMonth = false,
  monthTotals,
}: TransactionTableProps) {
  const { data: allAccounts = [] } = useAccounts();
  const { data: _cats = [] } = useCategories(); // prefetch so CategoryPicker is instant
  // The card list on a phone, and wherever the table is embedded narrow.
  const isMobile = useIsMobile() || compact;

  // Accounts filtered to this tab's type group
  const tabAccounts = accountTypeGroup
    ? allAccounts.filter((a) =>
        (ACCOUNT_TYPE_GROUPS[accountTypeGroup] ?? []).includes(a.account_type)
      )
    : allAccounts;

  // When externalFilters is provided, the parent fully controls dates and account.
  const isExternallyControlled = !!externalFilters;

  // Shared date range from context (Transactions section tabs share this).
  // Budget pages supply externalFilters so the context date is ignored there.
  const { dateRange, setDateRange } = useTransactionDateRange();

  // A chosen sort is remembered with the other UI prefs, the way the date range
  // is — reopening Transactions should not silently throw it away. Budgeting
  // embeds this table with its own pinned filters, so only the standalone
  // section reads and writes the shared preference.
  const savedSort = useUiPrefsStore((s) => s.tableSort.transactions);
  const setTableSort = useUiPrefsStore((s) => s.setTableSort);
  const rememberSort = !isExternallyControlled;

  // A link to one account (a Portfolio row) arrives as ?account=<id>.
  const [searchParams, setSearchParams] = useSearchParams();
  const linkedAccountId = isExternallyControlled ? null : Number(searchParams.get("account")) || null;

  const [filters, setFilters] = useState<TransactionFilters>({
    account_type_group: accountTypeGroup,
    exclude_transfers: excludeTransfers || undefined,
    ...(isExternallyControlled
      ? {}  // parent supplies date/account via externalFilters below
      : { date_from: dateRange?.from, date_to: dateRange?.to }),  // null is "All time"
    sort_by: (rememberSort && savedSort?.key) || "date",
    sort_order: (rememberSort && savedSort?.dir) || "desc",
    account_id: linkedAccountId ?? undefined,
    page: 1,
    page_size: 20,
    fetch_all: false,
    ...externalFilters,  // last: parent values win
  });
  const [rawSearch, setRawSearch] = useState("");
  const debouncedSearch = useDebounce(rawSearch, 300);

  // Follow the tab. This used to be done by remounting the component from the
  // route (`key={tab}`), which threw away the loaded rows and made every tab
  // switch flash a skeleton. The account filter resets with it: an account on
  // the Cash tab is not in the Credit Cards tab. [issue 210]
  useEffect(() => {
    setFilters((f) =>
      f.account_type_group === accountTypeGroup &&
      f.exclude_transfers === (excludeTransfers || undefined)
        ? f
        : {
            ...f,
            account_type_group: accountTypeGroup,
            exclude_transfers: excludeTransfers || undefined,
            account_id: undefined,
            page: 1,
          },
    );
    setRawSearch("");
  }, [accountTypeGroup, excludeTransfers]);

  // Apply a linked account, after the tab effect above so a tab change in the
  // same navigation does not clear it. The parameter then leaves the address,
  // so clearing the filter stays cleared on a reload.
  useEffect(() => {
    if (!linkedAccountId) return;
    setFilters((f) => ({ ...f, account_id: linkedAccountId, page: 1 }));
    setSearchParams((p) => { p.delete("account"); return p; }, { replace: true });
  }, [linkedAccountId, setSearchParams]);

  // When externalFilters change (parent changes account or date), merge them in and reset page.
  useEffect(() => {
    if (!externalFilters) return;
    setFilters((f) => ({ ...f, ...externalFilters, page: 1 }));
    setRawSearch("");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(externalFilters)]);


  // ----- Bulk edit state ----------------------------------------------------
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ----- Drawer state -------------------------------------------------------
  const [drawerTxn, setDrawerTxn] = useState<Transaction | null>(null);

  // ----- Hand entry ----------------------------------------------------
  // Every account takes hand-entered rows.
  const manualAccounts = tabAccounts;
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState<{ id: number; name: string } | null>(null);

  // ----- Sync debounced search → filters ------------------------------------
  useEffect(() => {
    setFilters((f) => ({
      ...f,
      search: debouncedSearch || undefined,
      page: 1,
    }));
  }, [debouncedSearch]);

  // ----- Sync date range → filters (standalone use only) --------------------
  // IMPORTANT: skip when externally controlled — firing here with dateRange=null
  // would overwrite the parent's date filters with undefined.
  useEffect(() => {
    if (isExternallyControlled) return;
    setFilters((f) => ({
      ...f,
      date_from: dateRange?.from,
      date_to: dateRange?.to,
      page: 1,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateRange]);

  // ----- Data ---------------------------------------------------------------
  const { data, isLoading } = useTransactions(filters);
  const deleteTxn = useDeleteTransaction();
  const bulkUpdate = useBulkUpdateTransactions();

  // How many unsettled rows match the *current* filters, independent of paging
  // and of the pending toggle itself — a badge counting only the visible page
  // would be wrong as soon as the list spans more than one.
  const { data: pendingData } = useTransactions({
    ...filters,
    only_pending: true,
    exclude_pending: undefined,
    page: 1,
    page_size: 1,
    fetch_all: false,
  });
  const pendingCount = pendingData?.total ?? 0;

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalAmount = data?.total_amount ?? 0;
  const pageSize = filters.fetch_all ? total : (filters.page_size ?? 20);
  const totalPages = filters.fetch_all ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const currentPage = filters.fetch_all ? 1 : (filters.page ?? 1);

  // ----- Selection helpers --------------------------------------------------
  const allVisible =
    items.length > 0 && items.every((t) => selectedIds.has(t.id));

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allVisible) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((t) => next.delete(t.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        items.forEach((t) => next.add(t.id));
        return next;
      });
    }
  }

  // ----- Sort ---------------------------------------------------------------
  function handleSort(col: string) {
    const order = filters.sort_by === col && filters.sort_order === "desc" ? "asc" : "desc";
    if (rememberSort) setTableSort("transactions", { key: col, dir: order });
    setFilters((f) => ({ ...f, sort_by: col, sort_order: order, page: 1 }));
  }

  // ----- Bulk actions -------------------------------------------------------
  function handleBulkApply(updates: { category_id?: number | null; description?: string; notes?: string }) {
    bulkUpdate.mutate({
      transaction_ids: Array.from(selectedIds),
      ...updates,
    });
    setSelectedIds(new Set());
  }

  function handleBulkDelete() {
    selectedIds.forEach((id) => deleteTxn.mutate(id));
    setSelectedIds(new Set());
  }

  // ----- Column count (for empty/loading colSpan) ---------------------------
  // columns: [checkbox?] date, account, [member?], description, category, amount
  const colCount = (bulkEditMode ? 1 : 0) + 5 + (showMemberName ? 1 : 0);

  const sortBy = filters.sort_by ?? "date";
  const sortOrder = filters.sort_order ?? "desc";

  // ----- Empty state: say why, and offer the next step ---------------
  const selectedAcct = filters.account_id != null ? allAccounts.find((a) => a.id === filters.account_id) : undefined;
  const selectedTakesRows = !!selectedAcct;
  const narrowed = !!(filters.search || filters.only_pending || filters.date_from || filters.date_to);
  const emptyState = (
    <div className="flex flex-col items-center gap-3 text-center text-sm">
      <p className="max-w-xl break-words text-muted-foreground">
        {allAccounts.length === 0
          ? "No accounts yet. Add one to start tracking transactions."
          : selectedAcct
            ? `No transactions in ${selectedAcct.display_name}${narrowed ? " match these filters" : " yet"}.`
            : narrowed
              ? "No transactions match these filters."
              : "No transactions yet."}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {filters.search && (
          <Button size="sm" variant="outline" onClick={() => setRawSearch("")}>Clear search</Button>
        )}
        {!isExternallyControlled && (selectedAcct ? selectedTakesRows : manualAccounts.length > 0) && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} />
            Add a transaction
          </Button>
        )}
        {!isExternallyControlled && selectedAcct && selectedTakesRows && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setImporting({ id: selectedAcct.id, name: selectedAcct.display_name })}
          >
            <Upload size={13} />
            Import a file
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {/* Section header, matching every other section of the app: the heading
          and its headline figure on the left, the date range and account
          controls on the right. These two used to sit mid-toolbar between the
          search box and Bulk Edit, which is where nobody else keeps them.
          */}
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{title}</h2>
            {!isLoading && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {total.toLocaleString()} transaction{total === 1 ? "" : "s"}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!isExternallyControlled && (
              <DateRangePicker
                value={dateRange}
                onChange={setDateRange}
                onClearAll={() => setDateRange(null)}
              />
            )}
            {!isExternallyControlled && tabAccounts.length > 1 && (
              <AccountFilterSelect
                value={filters.account_id}
                onChange={(id) => setFilters((f) => ({ ...f, account_id: id, page: 1 }))}
                accounts={tabAccounts.map((a) => ({ id: a.id, name: a.display_name }))}
              />
            )}
          </div>
        </div>
      )}
      {showBreakdown && (
        <TransactionBreakdown
          filters={filters}
          byAccount={!!accountTypeGroup}
          selectedAccount={
            filters.account_id != null
              ? {
                  id: filters.account_id,
                  name: allAccounts.find((a) => a.id === filters.account_id)?.display_name ?? "Selected account",
                }
              : null
          }
          onSelectAccount={(id) => setFilters((f) => ({ ...f, account_id: id, page: 1 }))}
        />
      )}
      {/* ── Toolbar ────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="flex items-center flex-1 min-w-[180px] rounded-md border border-border bg-background px-3 gap-2">
          <Search size={14} className="text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search…"
            value={rawSearch}
            onChange={(e) => setRawSearch(e.target.value)}
            className="flex-1 py-1.5 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground"
          />
          {rawSearch && (
            <button onClick={() => setRawSearch("")} className="text-muted-foreground hover:text-foreground">
              <X size={13} />
            </button>
          )}
        </div>

        {/* Date range and account filter live in the section header above when
            there is one; without a header (Budgeting's embedded table) they
            stay here, next to the search box. */}
        {!title && !isExternallyControlled && (
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
            onClearAll={() => setDateRange(null)}
          />
        )}
        {!title && !isExternallyControlled && tabAccounts.length > 1 && (
          <AccountFilterSelect
            value={filters.account_id}
            onChange={(id) => setFilters((f) => ({ ...f, account_id: id, page: 1 }))}
            accounts={tabAccounts.map((a) => ({ id: a.id, name: a.display_name }))}
          />
        )}

        {/* Bulk edit toggle */}
        <FeatureTip
          id="bulk-edit"
          title="Edit many at once"
          enabled={!bulkEditMode && items.length > 1}
          placement="bottom-end"
        >
          Turn on <span className="font-medium">Bulk Edit</span> to select multiple
          transactions and recategorize, tag, or delete them in one go.
        </FeatureTip>
        <Button
          variant={bulkEditMode ? "primary" : "outline"}
          size="sm"
          onClick={() => {
            setBulkEditMode((v) => !v);
            setSelectedIds(new Set());
          }}
        >
          <SlidersHorizontal size={13} />
          {bulkEditMode ? "Done" : "Bulk Edit"}
        </Button>

        {!isExternallyControlled && manualAccounts.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
          >
            <Plus size={13} />
            Add transaction
          </Button>
        )}

        {/* Pending toggle — only where unsettled rows are actually shown, and
            only once there is something to filter, so it stays invisible for
            CSV/manual-only users and on the budgeting pages. */}
        {pendingCount > 0 && !filters.exclude_pending && (
          <Button
            variant={filters.only_pending ? "primary" : "outline"}
            size="sm"
            title="Transactions not yet settled at the bank. They are excluded from budgets and net worth."
            onClick={() =>
              setFilters((f) => ({
                ...f,
                only_pending: f.only_pending ? undefined : true,
                page: 1,
              }))
            }
          >
            Pending {pendingCount}
          </Button>
        )}

        {/* Sort — mobile only; the table headers handle this on desktop */}
        {isMobile && (
          <select
            value={`${sortBy}-${sortOrder}`}
            onChange={(e) => {
              const [col, order] = e.target.value.split("-") as [string, "asc" | "desc"];
              if (rememberSort) setTableSort("transactions", { key: col, dir: order });
              setFilters((f) => ({ ...f, sort_by: col, sort_order: order, page: 1 }));
            }}
            className="rounded-md border border-border bg-background px-3 py-1.5 min-h-[40px] text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="amount-desc">Largest amount</option>
            <option value="amount-asc">Smallest amount</option>
            <option value="description-asc">Description A–Z</option>
          </select>
        )}
      </div>

      {/* Select-all for the mobile list (the table header checkbox handles md+) */}
      {isMobile && bulkEditMode && items.length > 0 && (
        <button
          onClick={toggleAll}
          className="self-start text-xs font-medium text-primary underline"
        >
          {allVisible ? "Deselect all on page" : "Select all on page"}
        </button>
      )}

      {/* ── Bulk action bar ────────────────────────────────────────────────── */}
      {bulkEditMode && selectedIds.size > 0 && (
        <BulkActionBar
          count={selectedIds.size}
          onApply={handleBulkApply}
          onDelete={handleBulkDelete}
          onClear={() => setSelectedIds(new Set())}
        />
      )}

      {/* ── Table (md+) / card list (mobile) ───────────────────────────────── */}
      <div className="rounded-xl border border-border overflow-hidden">
        {isMobile ? (
          <div className="bg-card divide-y divide-border/30">
            {isLoading ? (
              [...Array(8)].map((_, i) => (
                <div key={i} className="px-4 py-3">
                  <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                  <div className="h-3 w-1/2 rounded bg-muted animate-pulse mt-2" />
                </div>
              ))
            ) : items.length === 0 ? (
              <div className="px-4 py-12">{emptyState}</div>
            ) : (
              items.map((txn, i) => {
                const month = String(txn.date_posted).slice(0, 7);
                const newMonth = groupByMonth && (i === 0 || String(items[i - 1].date_posted).slice(0, 7) !== month);
                return (
                  <Fragment key={txn.id}>
                    {newMonth && (
                      <div className="flex items-center justify-between bg-muted/50 px-4 py-1.5 text-xs font-medium text-muted-foreground">
                        <span>{new Date(month + "-15").toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
                        {monthTotals?.[month] != null && <span className="tabular-nums">{formatCurrencyFull(monthTotals[month])}</span>}
                      </div>
                    )}
                    <TransactionCard
                      txn={txn}
                      bulkEditMode={bulkEditMode}
                      selected={selectedIds.has(txn.id)}
                      onSelect={toggleSelect}
                      onRowClick={setDrawerTxn}
                      showMemberName={showMemberName}
                    />
                  </Fragment>
                );
              })
            )}
          </div>
        ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 border-b border-border">
              <tr>
                {/* Select-all checkbox */}
                {bulkEditMode && (
                  <th className="pl-4 pr-2 py-2.5 w-8">
                    <input
                      type="checkbox"
                      checked={allVisible}
                      onChange={toggleAll}
                      className="rounded border-border accent-primary cursor-pointer"
                      disabled={items.length === 0}
                    />
                  </th>
                )}
                <SortHeader
                  col="date"
                  label="Date"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                />
                <SortHeader
                  col="account"
                  label="Account"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                />
                {showMemberName && (
                  <th className="px-4 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">
                    Card Member
                  </th>
                )}
                <SortHeader
                  col="description"
                  label="Description"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                  className="min-w-[180px]"
                />
                <SortHeader
                  col="category"
                  label="Category"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                />
                <SortHeader
                  col="amount"
                  label="Amount"
                  sortBy={sortBy}
                  sortOrder={sortOrder}
                  onSort={handleSort}
                  className="text-right [&>span]:justify-end"
                />
              </tr>
            </thead>

            <tbody className="bg-card divide-y divide-border/30">
              {isLoading ? (
                [...Array(8)].map((_, i) => (
                  <tr key={i}>
                    {[...Array(colCount)].map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-3.5 rounded bg-muted animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-12">
                    {emptyState}
                  </td>
                </tr>
              ) : (
                items.map((txn) => (
                  <TransactionRow
                    key={txn.id}
                    txn={txn}
                    bulkEditMode={bulkEditMode}
                    selected={selectedIds.has(txn.id)}
                    onSelect={toggleSelect}
                    onRowClick={setDrawerTxn}
                    showMemberName={showMemberName}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
        )}

        {/* ── Total footer ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border bg-muted/30 text-sm">
          <span className="text-muted-foreground">
            {total.toLocaleString()}{" "}
            transaction{total !== 1 ? "s" : ""}
            {filters.fetch_all ? "" : ` · page ${currentPage} of ${totalPages}`}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Net:</span>
            <span
              className={cn(
                "font-semibold tabular-nums",
                totalAmount >= 0
                  ? "text-success"
                  : "text-destructive"
              )}
            >
              {signedAmount(totalAmount)}
            </span>
          </div>
        </div>
      </div>

      {/* ── Pagination ─────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        {/* Page size selector */}
        <div className="flex items-center gap-2">
          <span>Show:</span>
          <select
            value={filters.fetch_all ? "all" : String(filters.page_size ?? 20)}
            onChange={(e) => {
              if (e.target.value === "all") {
                setFilters((f) => ({ ...f, fetch_all: true, page: 1 }));
              } else {
                setFilters((f) => ({
                  ...f,
                  page_size: Number(e.target.value),
                  fetch_all: false,
                  page: 1,
                }));
              }
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value="all">All</option>
          </select>
          <span>per page</span>
        </div>

        {/* Page navigation — dropdown + prev/next buttons */}
        {!filters.fetch_all && totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setFilters((f) => ({ ...f, page: Math.max(1, (f.page ?? 1) - 1) }))}
              disabled={currentPage <= 1}
              className="p-1 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Previous page"
            >
              <ChevronLeft size={14} />
            </button>
            <select
              value={currentPage}
              onChange={(e) =>
                setFilters((f) => ({ ...f, page: Number(e.target.value) }))
              }
              className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {Array.from({ length: totalPages }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} / {totalPages}
                </option>
              ))}
            </select>
            <button
              onClick={() => setFilters((f) => ({ ...f, page: Math.min(totalPages, (f.page ?? 1) + 1) }))}
              disabled={currentPage >= totalPages}
              className="p-1 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Next page"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
      </div>

      {/* ── Side drawer ────────────────────────────────────────────────────── */}
      <TransactionDrawer
        transaction={drawerTxn}
        onClose={() => setDrawerTxn(null)}
      />
      <AddTransactionDrawer
        open={adding}
        onClose={() => setAdding(false)}
        accounts={manualAccounts}
        defaultAccountId={filters.account_id}
      />
      {importing && (
        <CsvImportWizard
          open
          onClose={() => setImporting(null)}
          accountId={importing.id}
          accountName={importing.name}
        />
      )}
    </div>
  );
}

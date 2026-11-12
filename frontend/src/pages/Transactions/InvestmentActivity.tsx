import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Search, ChevronLeft, ChevronRight, X } from "@/lib/icons";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { useAccounts } from "@/hooks/useAccounts";
import { useDebounce } from "@/hooks/useDebounce";
import { useIsMobile } from "@/hooks/useMediaQuery";
import type { TradeAction } from "@/hooks/useHoldings";
import {
  useInvestmentActivity,
  type ActivityItem,
  type ActivityKind,
} from "@/hooks/useInvestmentActivity";
import { useTransactions } from "@/hooks/useTransactions";
import { cn, formatCurrencyFull } from "@/lib/utils";
import { TransactionTable } from "./TransactionTable";
import { useTransactionDateRange } from "./transactionContext";
import { formatDate } from "@/lib/dates";

const INVESTMENT_ACCOUNT_TYPES = ["brokerage", "401k", "ira", "roth_ira", "hsa", "529"];
const PAGE_SIZES = [10, 20, 50, 100] as const;

const KINDS: { value: ActivityKind | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "trades", label: "Buys and sales" },
  { value: "income", label: "Dividends and interest" },
  { value: "transfers", label: "Transfers" },
  { value: "other", label: "Fees and splits" },
];

const ACTION_LABELS: Record<TradeAction, string> = {
  buy: "Buy", sell: "Sell", dividend: "Dividend", reinvest: "Reinvestment",
  interest: "Interest", capgain: "Capital gain", split: "Split",
  fee: "Fee", transfer_in: "Transfer in", transfer_out: "Transfer out",
};

const ACTION_BADGE: Record<TradeAction, string> = {
  buy: "bg-success/10 text-success",
  sell: "bg-destructive/10 text-destructive",
  dividend: "bg-primary/10 text-primary",
  reinvest: "bg-primary/10 text-primary",
  interest: "bg-primary/10 text-primary",
  capgain: "bg-primary/10 text-primary",
  split: "bg-amber-500/15 text-amber-600",
  fee: "bg-muted text-muted-foreground",
  transfer_in: "bg-muted text-muted-foreground",
  transfer_out: "bg-muted text-muted-foreground",
};

function formatShares(item: ActivityItem) {
  if (item.action === "split") {
    return item.split_ratio != null
      ? `${item.split_ratio.toLocaleString(undefined, { maximumFractionDigits: 4 })} : 1`
      : "—";
  }
  return item.shares ? item.shares.toLocaleString(undefined, { maximumFractionDigits: 6 }) : "—";
}

function ActionBadge({ action }: { action: TradeAction }) {
  return (
    <span className={cn("px-1.5 py-0.5 rounded text-[11px] font-semibold whitespace-nowrap", ACTION_BADGE[action])}>
      {ACTION_LABELS[action] ?? action}
    </span>
  );
}

/** Money in reads green with a plus, as it does in the cash tables. */
function Total({ item }: { item: ActivityItem }) {
  if (item.total == null) return <span className="text-muted-foreground">—</span>;
  const cashIn = item.is_income || item.action === "sell";
  return (
    <span className={cn("tabular-nums", cashIn && "text-success")}>
      {cashIn ? "+" : ""}{formatCurrencyFull(item.total)}
    </span>
  );
}

/** A brokerage's activity: buys, sales, dividends, interest, fees.
 *
 *  These are trades on a holding, not rows in the cash ledger, so they get a
 *  list of their own. */
export function InvestmentActivity() {
  const { dateRange, setDateRange } = useTransactionDateRange();
  const isMobile = useIsMobile();
  const { data: accounts = [] } = useAccounts();
  const investmentAccounts = accounts.filter((a) => INVESTMENT_ACCOUNT_TYPES.includes(a.account_type));

  const [accountId, setAccountId] = useState<number | undefined>();
  const [kind, setKind] = useState<ActivityKind | undefined>();
  const [rawSearch, setRawSearch] = useState("");
  const search = useDebounce(rawSearch, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);

  // Any change to what is being asked for starts again from the first page.
  useEffect(() => setPage(1), [dateRange?.from, dateRange?.to, accountId, kind, search, pageSize]);

  const { data, isLoading } = useInvestmentActivity({
    date_from: dateRange?.from,
    date_to: dateRange?.to,
    account_id: accountId,
    kind,
    search: search || undefined,
    page,
    page_size: pageSize,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Cash rows in these accounts exist only where a file was imported. Show
  // that table when there is something in it, and not an empty one otherwise.
  const { data: cashRows } = useTransactions({ account_type_group: "investments", page_size: 1 });
  const hasCashRows = (cashRows?.total ?? 0) > 0;

  const emptyText = "No investment activity in this period.";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">Investment Activity</h2>
            {!isLoading && (
              <p className="text-sm text-muted-foreground tabular-nums">
                {total.toLocaleString()} {total === 1 ? "entry" : "entries"}
                {(data?.income_total ?? 0) > 0 && (
                  <> · {formatCurrencyFull(data!.income_total)} in dividends and interest</>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker value={dateRange} onChange={setDateRange} onClearAll={() => setDateRange(null)} />
            {investmentAccounts.length > 1 && (
              <AccountFilterSelect
                value={accountId}
                onChange={setAccountId}
                accounts={investmentAccounts.map((a) => ({ id: a.id, name: a.display_name }))}
              />
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center flex-1 min-w-[180px] rounded-md border border-border bg-background px-3 gap-2">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="Search by ticker or name…"
              value={rawSearch}
              onChange={(e) => setRawSearch(e.target.value)}
              className="flex-1 py-1.5 text-sm bg-transparent focus:outline-none placeholder:text-muted-foreground"
            />
            {rawSearch && (
              <button onClick={() => setRawSearch("")} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k.label}
                type="button"
                onClick={() => setKind(k.value)}
                aria-pressed={kind === k.value}
                className={cn(
                  "rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors",
                  kind === k.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border overflow-hidden">
          {isMobile ? (
            <div className="bg-card divide-y divide-border/30">
              {isLoading ? (
                [...Array(6)].map((_, i) => (
                  <div key={i} className="px-4 py-3">
                    <div className="h-4 w-2/3 rounded bg-muted animate-pulse" />
                    <div className="h-3 w-1/2 rounded bg-muted animate-pulse mt-2" />
                  </div>
                ))
              ) : items.length === 0 ? (
                <div className="px-4 py-12 text-center text-muted-foreground text-sm">{emptyText}</div>
              ) : (
                items.map((item) => (
                  <div key={item.id} className="px-4 py-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {item.ticker ?? item.security_name}{" "}
                        <ActionBadge action={item.action} />
                      </p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {formatDate(item.trade_date)} · {item.account_name}
                        {item.shares ? ` · ${formatShares(item)} sh` : ""}
                      </p>
                    </div>
                    <p className="text-sm font-medium shrink-0"><Total item={item} /></p>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 border-b border-border">
                  <tr>
                    {["Date", "Account", "Holding", "Type"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                    {["Shares", "Price", "Amount"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-right font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/30 bg-card">
                  {isLoading ? (
                    [...Array(6)].map((_, i) => (
                      <tr key={i}>
                        <td colSpan={7} className="px-4 py-3"><div className="h-4 rounded bg-muted animate-pulse" /></td>
                      </tr>
                    ))
                  ) : items.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">{emptyText}</td>
                    </tr>
                  ) : (
                    items.map((item) => (
                      <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                        <td className="px-4 py-2.5 tabular-nums whitespace-nowrap">{formatDate(item.trade_date)}</td>
                        <td className="px-4 py-2.5 text-muted-foreground max-w-[180px] truncate">{item.account_name}</td>
                        <td className="px-4 py-2.5 max-w-[260px]">
                          <Link to="/investments/stocks" className="hover:underline">
                            <span className="font-medium">{item.ticker ?? item.security_name}</span>
                          </Link>
                          {item.ticker && (
                            <span className="block text-xs text-muted-foreground truncate">{item.security_name}</span>
                          )}
                        </td>
                        <td className="px-4 py-2.5"><ActionBadge action={item.action} /></td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{formatShares(item)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">
                          {item.price_per_share != null ? formatCurrencyFull(item.price_per_share) : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium"><Total item={item} /></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <span>Show:</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>per page</span>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="p-1 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs tabular-nums">{page} / {totalPages}</span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="p-1 rounded border border-border bg-background text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Next page"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      </div>

      {hasCashRows && (
        <TransactionTable showBreakdown title="Cash in Investment Accounts" accountTypeGroup="investments" />
      )}
    </div>
  );
}

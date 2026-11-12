import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { X } from "@/lib/icons";
import { MAX_SLOTS, neutral, slotColor } from "@/lib/chartPalette";
import {
  useTransactionBreakdown, type BreakdownGroup, type TransactionBreakdown as TransactionBreakdownResponse, type TransactionFilters,
} from "@/hooks/useTransactions";
import { cn, formatCurrency } from "@/lib/utils";
import { BalanceTrendCard } from "@/components/portfolio/BalanceTrendCard";
import { useIsDarkMode } from "@/store/theme";

/**
 * Where the transactions in the table come from: a donut of how
 * many sit on each account type — or, on a type tab, each account — beside the
 * balances of those account types over the same dates. Built from the table's own filters
 * — except the account filter, which the donut shows as a highlight rather
 * than apply, so every account stays on screen to pick or un-pick. The stat
 * cards and the balance chart do apply it: filtered to one account, they total
 * and draw that account.
 */

/** Type groups in a fixed order; hues are handed out along it by identity. */
const TYPE_ORDER = ["cash", "credit_cards", "investments", "loan", "mortgage", "other"];
const TYPE_TAB: Record<string, string> = {
  cash: "/transactions/cash",
  credit_cards: "/transactions/credit-cards",
  investments: "/transactions/investments",
  loan: "/transactions/loan",
  mortgage: "/transactions/mortgage",
};

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  opacity: 0.97,
};

interface Slice extends BreakdownGroup {
  color: string;
  /** Folded "Other" bucket — no single destination. */
  folded?: boolean;
}

/** Colour by identity, never by rank; past the palette's eight hues the
 *  smallest groups fold into a neutral "Other" rather than reuse a hue. */
function toSlices(groups: BreakdownGroup[], byAccount: boolean, dark: boolean): Slice[] {
  const rank = (g: BreakdownGroup) =>
    byAccount ? Number(g.key) : (TYPE_ORDER.indexOf(g.key) + 1 || TYPE_ORDER.length + 1);

  let kept = groups;
  let folded: BreakdownGroup | null = null;
  if (groups.length > MAX_SLOTS) {
    const bySize = [...groups].sort((a, b) => b.count - a.count);
    kept = bySize.slice(0, MAX_SLOTS - 1);
    const rest = bySize.slice(MAX_SLOTS - 1);
    folded = {
      key: "__other", label: `Other (${rest.length})`, account_type: null,
      count: rest.reduce((s, g) => s + g.count, 0),
      inflow: rest.reduce((s, g) => s + g.inflow, 0),
      outflow: rest.reduce((s, g) => s + g.outflow, 0),
      net: rest.reduce((s, g) => s + g.net, 0),
    };
  }
  const slotOf = new Map(
    [...kept].sort((a, b) => rank(a) - rank(b)).map((g, i) => [g.key, i] as const),
  );
  const slices: Slice[] = kept.map((g) => ({ ...g, color: slotColor(slotOf.get(g.key) ?? 0, dark) }));
  if (folded) slices.push({ ...folded, color: neutral(dark), folded: true });
  return slices;
}

export function TransactionBreakdown({
  filters,
  byAccount,
  selectedAccount,
  onSelectAccount,
}: {
  filters: TransactionFilters;
  /** True on a type tab: split by account instead of by account type. */
  byAccount: boolean;
  /** The account the table is currently narrowed to, if any. */
  selectedAccount?: { id: number; name: string } | null;
  /** Narrow the table to an account, or `undefined` to show all again. */
  onSelectAccount?: (accountId: number | undefined) => void;
}) {
  const dark = useIsDarkMode();
  const navigate = useNavigate();
  const groupBy = byAccount ? "account" : "type_group";
  // The charts ignore the table's account filter on purpose: narrowing the
  // table to one account must not collapse the donut to a single 100% slice
  // — the other accounts stay on screen (dimmed) so the user can switch to
  // one, or click the selected one again to go back to all.
  const chartFilters = useMemo(() => ({ ...filters, account_id: undefined }), [filters]);
  const { data, isLoading } = useTransactionBreakdown(chartFilters, groupBy, true);
  // The stat cards, unlike the donut, follow the account filter: they are
  // the totals of what the table lists.
  const filtered = filters.account_id != null;
  const { data: own } = useTransactionBreakdown(filters, groupBy, filtered);
  const stats = filtered ? own : data;
  const selectedKey = selectedAccount ? String(selectedAccount.id) : null;
  const dimmed = (s: Slice) => byAccount && selectedKey !== null && s.key !== selectedKey;

  const slices = useMemo(() => toSlices(data?.groups ?? [], byAccount, dark), [data, byAccount, dark]);
  const total = data?.total_count ?? 0;
  // On a type's tab, a balance line per account in its donut colour, so a
  // card or bank reads the same on both charts. Accounts folded into
  // "Other" have no colour of their own and are left off the lines, as is
  // the checking account a mortgage is paid from: its balance is not a debt.
  const debtType = filters.account_type_group ? DEBT_ACCOUNT_TYPE[filters.account_type_group] : undefined;
  const lineAccounts = useMemo(
    () => byAccount
      ? slices
        .filter((s) => !s.folded && (!debtType || s.account_type === debtType))
        .map((s) => ({ id: Number(s.key), name: s.label, color: s.color }))
      : undefined,
    [byAccount, slices, debtType],
  );

  function select(s: Slice) {
    if (s.folded) return;
    if (byAccount) onSelectAccount?.(s.key === selectedKey ? undefined : Number(s.key));
    else if (TYPE_TAB[s.key]) navigate(TYPE_TAB[s.key]);
  }
  const clickable = (s: Slice) => !s.folded && (byAccount ? !!onSelectAccount : !!TYPE_TAB[s.key]);

  const title = byAccount ? "Breakdown by account" : "Breakdown by account type";
  // The section label above already says "Breakdown"; the card says what the
  // slices are, the way Budgeting's card says "By Source".
  const chartTitle = byAccount ? "By account" : "By account type";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* A plain section label, like Budgeting's charts carry. This used to be
            a collapse toggle — no other section hides its charts behind one,
            and the one that did was the odd page out. */}
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        {/* The way back to everything — whether the account was picked here or
            in the toolbar. */}
        {selectedAccount && onSelectAccount && (
          <div className="flex min-w-0 items-center gap-2 text-xs">
            <span className="inline-flex min-w-0 max-w-[18rem] items-center gap-1 rounded-full bg-primary/10 text-primary pl-2.5 pr-1 py-0.5 font-medium" title={selectedAccount.name}>
              <span className="truncate">Showing: {selectedAccount.name}</span>
              <button
                type="button"
                onClick={() => onSelectAccount(undefined)}
                aria-label={`Stop filtering to ${selectedAccount.name}`}
                className="rounded-full p-0.5 hover:bg-primary/15"
              >
                <X size={12} />
              </button>
            </span>
            <button
              type="button"
              onClick={() => onSelectAccount(undefined)}
              className="text-primary hover:underline font-medium"
            >
              Show all accounts
            </button>
          </div>
        )}
      </div>

      {isLoading && !data ? (
        <div className="h-44 rounded-xl bg-muted animate-pulse" />
      ) : total === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No transactions match these filters.</p>
      ) : (
        <div className="space-y-4">
        {stats ? (
          <StatCards stats={stats} group={filters.account_type_group} />
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-[62px] rounded-xl bg-muted animate-pulse" />)}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Share of transactions — the donut, with a labelled legend. */}
          <div className="rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-medium text-muted-foreground mb-3">{chartTitle}</h3>
            <BreakdownDonut
              slices={slices}
              total={total}
              onSelect={select}
              clickable={clickable}
              dimmed={dimmed}
              selectedKey={selectedKey}
              pressable={byAccount}
            />
          </div>

          {/* Where the balances went over the same dates. This card used to
              rank money in or out by group, which the stat cards above and
              the donut beside it already say. */}
          <BalanceTrendCard
            dateFrom={filters.date_from}
            dateTo={filters.date_to}
            only={filters.account_type_group}
            account={selectedAccount}
            accounts={lineAccounts}
          />
        </div>
        </div>
      )}
    </div>
  );
}

/** The account type each debt tab is about. */
const DEBT_ACCOUNT_TYPE: Record<string, string> = {
  credit_cards: "credit_card",
  loan: "loan",
  mortgage: "mortgage",
};

/** What the debt tabs call the two sides of the ledger, read from the debt's
 *  side. On Credit Cards, payments are transfers and so are not listed:
 *  what comes in is refunds and credits. */
const DEBT_LABELS: Record<string, { paid: string; charged: string; net: string }> = {
  credit_cards: { paid: "Refunds and credits", charged: "Purchases and fees", net: "Net charged" },
  loan: { paid: "Paid", charged: "Interest and fees", net: "Net paid" },
  mortgage: { paid: "Paid", charged: "Interest, fees and escrow", net: "Net paid" },
};

/** The four headline cards. On a debt tab they read paid against charged
 *  rather than money in against money out, which on the Mortgage tab counted
 *  the bank's payment and the lender's credit for it as two things. */
function StatCards({ stats, group }: { stats: TransactionBreakdownResponse; group?: string }) {
  const labels = group ? DEBT_LABELS[group] : undefined;
  if (stats.debt?.split && stats.debt.split.basis) {
    return <PaymentSplitCards debt={stats.debt} count={stats.total_count} group={group} />;
  }
  if (labels && stats.debt) {
    const { paid, charged, net_paid, matched_payments } = stats.debt;
    // A card's net is what was spent; a loan's is how far it was paid down.
    const cardTab = group === "credit_cards";
    const net = cardTab ? -net_paid : net_paid;
    const good = cardTab ? net <= 0 : net >= 0;
    return (
      <>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Transactions" value={stats.total_count.toLocaleString()} />
          <Stat label={labels.paid} value={formatCurrency(paid)} className="text-success" />
          <Stat label={labels.charged} value={formatCurrency(charged)} className="text-destructive" />
          <Stat label={labels.net} value={formatCurrency(net)} className={good ? "text-success" : "text-destructive"} />
        </div>
        {matched_payments > 0 && (
          <p className="text-xs text-muted-foreground">
            {matched_payments === 1 ? "One payment" : `${matched_payments} payments`} from your bank{" "}
            {matched_payments === 1 ? "is" : "are"} listed below alongside the credit from your lender for{" "}
            {matched_payments === 1 ? "it" : "them"}, and counted once.
          </p>
        )}
      </>
    );
  }
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <Stat label="Transactions" value={stats.total_count.toLocaleString()} />
      <Stat label="Money in" value={formatCurrency(stats.total_inflow)} className="text-success" />
      <Stat label="Money out" value={formatCurrency(stats.total_outflow)} className="text-destructive" />
      <Stat
        label="Net"
        value={formatCurrency(stats.total_inflow - stats.total_outflow)}
        className={stats.total_inflow - stats.total_outflow >= 0 ? "text-success" : "text-destructive"}
      />
    </div>
  );
}

/** Where the principal and interest figures came from, said under the cards. */
const SPLIT_SOURCE: Record<string, string> = {
  reported: "Principal and interest as your lender reports them for this year.",
  payments: "Calculated from each payment, the loan's rate and what is owed today.",
  loan_details: "Principal and interest are estimated from the loan details under Property.",
  lender_share: "Principal and interest are estimated from the interest your lender reports for this year. Select This year for the exact figures.",
  balance: "Principal and interest are estimated from how far the balance fell.",
};

/** The Loan and Mortgage cards: what was paid, then how it
 *  split into principal, interest, and escrow and fees. The split is exact
 *  only when the lender reports it; otherwise each card says it is an estimate
 *  and the line beneath says how to get a closer one. */
function PaymentSplitCards({ debt, count, group }: {
  debt: NonNullable<TransactionBreakdownResponse["debt"]>;
  count: number;
  group?: string;
}) {
  const split = debt.split!;
  // From the balance alone, escrow and fees cannot be told from interest.
  const lumped = split.basis === "balance";
  const est = split.estimated ? " (estimate)" : "";
  const mortgage = group === "mortgage";
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat label="Paid" value={formatCurrency(debt.paid)} className="text-success" />
        <Stat
          label={`Principal${est}`}
          value={formatCurrency(split.principal)}
          note={split.extra ? `includes ${formatCurrency(split.extra)} extra` : undefined}
        />
        <Stat
          label={`${lumped ? (mortgage ? "Interest and escrow" : "Interest and fees") : "Interest"}${est}`}
          value={formatCurrency(split.interest)}
          className="text-destructive"
        />
        {lumped ? (
          <Stat label="Transactions" value={count.toLocaleString()} />
        ) : (
          <Stat label={`${mortgage ? "Escrow and fees" : "Fees and other"}${est}`} value={formatCurrency(split.other)} />
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {split.basis === "payments" && split.rate != null
          ? `Calculated from each payment, the loan's ${split.rate}% rate and what is owed today.`
          : SPLIT_SOURCE[split.basis!]}
        {split.estimated && split.basis !== "loan_details" && mortgage && (
          <>
            {" "}
            <Link to="/investments/property" className="text-primary hover:underline">
              Add the loan details to your property
            </Link>{" "}
            for a closer estimate.
          </>
        )}
        {debt.matched_payments > 0 && (
          <>
            {" "}
            {debt.matched_payments === 1 ? "One payment" : `${debt.matched_payments} payments`} from your bank{" "}
            {debt.matched_payments === 1 ? "is" : "are"} listed below alongside the credit from your lender, and counted once.
          </>
        )}
      </p>
    </>
  );
}

/** One headline figure, in the same card Budgeting's Cash Flow page uses. */
/** The share of transactions per slice, as a donut with a labelled legend:
 *  the Transactions breakdown card, and the "Transactions by Account Type"
 *  dashboard widget. */
function BreakdownDonut({ slices, total, onSelect, clickable, dimmed, selectedKey, pressable }: {
  slices: Slice[];
  total: number;
  onSelect: (s: Slice) => void;
  clickable: (s: Slice) => boolean;
  dimmed: (s: Slice) => boolean;
  selectedKey: string | null;
  /** Slices toggle a filter (by account), so they report a pressed state. */
  pressable: boolean;
}) {
  return (
    <div className="flex gap-4 items-start">
    <div className="relative flex-1 min-w-0">
      <ResponsiveContainer width="100%" height={240}>
        <PieChart>
          <Pie
            data={slices}
            dataKey="count"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={55}
            outerRadius={95}
            paddingAngle={2}
            stroke="hsl(var(--card))"
            strokeWidth={2}
            isAnimationActive={false}
            onClick={(s: Slice) => onSelect(s)}
          >
            {slices.map((s) => (
              <Cell
                key={s.key}
                fill={s.color}
                fillOpacity={dimmed(s) ? 0.3 : 1}
                className={clickable(s) ? "cursor-pointer" : undefined}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={tooltipStyle}
            formatter={(v: number, name: string) => [
              `${v.toLocaleString()} (${((v / total) * 100).toFixed(1)}%)`,
              name,
            ]}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="text-center">
          <p className="text-sm font-bold tabular-nums">{total.toLocaleString()}</p>
          <p className="text-[10px] text-muted-foreground">transactions</p>
        </div>
      </div>
    </div>
    {/* Same legend as Budgeting's: swatch and name on one line,
        the numbers muted beneath it. */}
    <div className="w-36 shrink-0 space-y-1.5 overflow-y-auto max-h-[240px] py-1">
      {slices.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onSelect(s)}
          aria-pressed={pressable && clickable(s) ? s.key === selectedKey : undefined}
          className={cn(
            "w-full text-left rounded-md px-2 py-1 transition-colors hover:bg-muted/50",
            dimmed(s) ? "opacity-40" : "opacity-100",
            clickable(s) ? "cursor-pointer" : "cursor-default",
          )}
        >
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: s.color }} />
            <span className={cn("text-xs truncate", s.key === selectedKey && "font-semibold")}>
              {s.label}
            </span>
          </div>
          <div className="pl-3.5 text-xs text-muted-foreground tabular-nums">
            {s.count.toLocaleString()} · {((s.count / total) * 100).toFixed(0)}%
          </div>
        </button>
      ))}
    </div>
    </div>
  );
}

/** Transactions by account type over a range, for the dashboard. A slice opens
 *  that type's tab, as on the Transactions page. */
export function TransactionsByTypeDonut({ dateFrom, dateTo }: { dateFrom?: string; dateTo?: string }) {
  const dark = useIsDarkMode();
  const navigate = useNavigate();
  const filters = useMemo(() => ({ date_from: dateFrom, date_to: dateTo }), [dateFrom, dateTo]);
  const { data, isLoading } = useTransactionBreakdown(filters, "type_group", true);
  const slices = useMemo(() => toSlices(data?.groups ?? [], false, dark), [data, dark]);
  const total = data?.total_count ?? 0;
  if (isLoading && !data) return <div className="h-44 rounded-xl bg-muted animate-pulse" />;
  if (total === 0) return <p className="py-8 text-center text-sm text-muted-foreground">No transactions in this period.</p>;
  return (
    <BreakdownDonut
      slices={slices}
      total={total}
      onSelect={(s) => { if (!s.folded && TYPE_TAB[s.key]) navigate(TYPE_TAB[s.key]); }}
      clickable={(s) => !s.folded && !!TYPE_TAB[s.key]}
      dimmed={() => false}
      selectedKey={null}
      pressable={false}
    />
  );
}

function Stat({ label, value, className, note }: { label: string; value: string; className?: string; note?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-lg font-semibold tabular-nums", className)}>{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

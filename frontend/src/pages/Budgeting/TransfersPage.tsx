import { useState } from "react";
import {
  Bar,
  BarChart,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DateRangePicker } from "@/components/ui/DateRangePicker";
import { AccountFilterSelect } from "@/components/ui/AccountFilterSelect";
import { useAccounts } from "@/hooks/useAccounts";
import { useTransfers } from "@/hooks/useBudget";
import { TransactionTable } from "@/pages/Transactions/TransactionTable";
import { formatCurrency } from "@/lib/utils";
import { useBudgetDateRange } from "./budgetContext";
import { TransferReview } from "./TransferReview";
import { moneyAxisFor } from "@/lib/chartTicks";

const POS = "#22c55e";
const NEG = "#ef4444";

/** Net transfers per category: money in to the right, out to the left. Also
 *  the "Transfers by Category" dashboard widget. */
export function TransfersNetChart({ rows }: { rows: { category_name: string; net: number }[] }) {
  const barData = rows.filter((c) => c.net !== 0).map((c) => ({ name: c.category_name, net: c.net }));
  const barHeight = Math.max(140, barData.length * 44 + 36);
  return (
    <ResponsiveContainer width="100%" height={barHeight}>
      <BarChart data={barData} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 4 }}>
        <XAxis type="number" {...moneyAxisFor(barData, ["net"], { fromZero: true })} tick={{ fontSize: 10 }} />
        <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 11 }} />
        <ReferenceLine x={0} stroke="hsl(var(--border))" />
        <Tooltip
          cursor={false}
          formatter={(value: number) => [`${value >= 0 ? "In" : "Out"} ${formatCurrency(Math.abs(value))}`, "Net"]}
          contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12, opacity: 0.97 }}
        />
        <Bar dataKey="net" radius={3} barSize={24}>
          {barData.map((d, i) => (
            <Cell key={i} fill={d.net >= 0 ? POS : NEG} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Transfers tab — net-worth-neutral movements (account transfers, card payments,
 * security buys/sells, refunds, reimbursements). Deliberately excluded from the
 * Income and Expense totals; this is their single, neutral home.
 *
 * Transfers are mixed-sign, so a donut/share-of-total view would mislead. Instead
 * we show an in/out summary and a diverging net-by-category bar (money in to the
 * right, out to the left), then the full transaction list.
 */
export function TransfersPage() {
  const { dateRange, setDateRange } = useBudgetDateRange();
  const range = dateRange;
  const [accountId, setAccountId] = useState<number | undefined>(undefined);

  const { data: allAccounts = [] } = useAccounts();

  const params = { date_from: range?.from, date_to: range?.to, account_id: accountId };
  const { data, isLoading } = useTransfers(params);

  const totalIn = data?.total_in ?? 0;
  const totalOut = data?.total_out ?? 0;
  const totalNet = data?.total_net ?? 0;

  const hasBars = (data?.by_category ?? []).some((c) => c.net !== 0);

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Transfers &amp; Payments</h2>
          <p className="text-sm text-muted-foreground max-w-xl">
            Net-worth-neutral movements: account transfers, credit-card payments, security
            buys &amp; sells, refunds, and reimbursements. Excluded from income &amp; expense totals.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangePicker
            value={dateRange}
            onChange={setDateRange}
            onClearAll={() => setDateRange(null)}
          />
          {allAccounts.length > 1 && (
            <AccountFilterSelect
              value={accountId}
              onChange={(id) => { setAccountId(id); }}
              accounts={allAccounts.map((a) => ({ id: a.id, name: a.display_name }))}
            />
          )}
        </div>
      </div>

      {/* ── In / out summary ───────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Transferred in", value: totalIn, cls: "text-success" },
          { label: "Transferred out", value: Math.abs(totalOut), cls: "text-destructive" },
          { label: "Net", value: totalNet, cls: totalNet >= 0 ? "text-success" : "text-destructive", signed: true },
        ].map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">{card.label}</p>
            {isLoading ? (
              <div className="h-6 w-24 rounded bg-muted animate-pulse mt-1" />
            ) : (
              <p className={`text-lg font-semibold ${card.cls}`}>
                {card.signed && card.value < 0 ? "−" : ""}
                {formatCurrency(Math.abs(card.value))}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* ── Suggested pairs awaiting review ────────────────────────────────── */}
      <TransferReview />

      {/* ── Net by category (diverging) ────────────────────────────────────── */}
      {!isLoading && hasBars && (
        <div className="rounded-xl border border-border bg-card p-4">
          <h3 className="text-sm font-medium text-muted-foreground mb-1">Net by category</h3>
          <p className="text-xs text-muted-foreground mb-3">Money in to the right, out to the left.</p>
          <TransfersNetChart rows={data?.by_category ?? []} />
        </div>
      )}

      {/* ── Transaction table ──────────────────────────────────────────────── */}
      <TransactionTable
        key={`xfer-${range?.from ?? "all"}-${range?.to ?? "all"}-${accountId ?? "all"}`}
        externalFilters={{
          date_from: range?.from,
          date_to: range?.to,
          account_id: accountId,
          only_transfers: true,
          // Matches the totals above; see ExpensesPage.
          exclude_pending: true,
        }}
      />
    </div>
  );
}

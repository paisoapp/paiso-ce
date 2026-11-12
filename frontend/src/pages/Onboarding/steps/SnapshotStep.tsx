import { useEffect, useMemo } from "react";
import { ArrowRight, LayoutDashboard, PieChart } from "@/lib/icons";
import { cn, formatCurrency } from "@/lib/utils";
import { useExpenses } from "@/hooks/useBudget";
import { usePortfolioSummary } from "@/hooks/usePortfolio";
import { useTransactions } from "@/hooks/useTransactions";
import { StepActions, primaryBtn } from "./StepActions";
import { defaultRange, formatRangeDates } from "@/components/ui/DateRangePicker";

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={strong ? "mt-1 text-2xl font-bold tabular-nums" : "mt-1 text-lg font-semibold tabular-nums"}>
        {value}
      </p>
    </div>
  );
}


/**
 * The first thing the user sees built from their own money. It is the point
 * of the wizard: every earlier step exists to get here.
 *
 * It does not ask "does this look right?". The numbers came from the user's
 * own institutions or their own files, and a question they cannot answer on
 * the spot only adds doubt. It offers the two places worth going next.
 */
function NextCard({
  icon: Icon, title, body, onClick, recommended = false,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  onClick: () => void;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-colors",
        recommended
          ? "border-primary bg-primary/5 ring-1 ring-primary hover:bg-primary/10"
          : "border-border bg-card hover:border-primary hover:bg-primary/5",
      )}
    >
      {recommended && (
        <span className="absolute right-3 top-3 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary-foreground">
          Recommended
        </span>
      )}
      <span
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-lg",
          recommended ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="flex items-center gap-1.5 text-sm font-semibold">
          {title}
          <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">{body}</span>
      </span>
    </button>
  );
}

/** Where the snapshot can send the user on. */
type SnapshotDestination = "dashboard" | "portfolio";

export function SnapshotStep({
  onBack, onNext, onContinue,
}: {
  onBack?: () => void;
  /** On to the setup steps still owed, when there are any. */
  onNext?: () => void;
  onContinue: (to: SnapshotDestination) => void;
}) {
  const go = (to: SnapshotDestination) => {
    onContinue(to);
  };
  const { data: summary, isLoading } = usePortfolioSummary();
  const { data: txns } = useTransactions({ page: 1, page_size: 1 });

  // Wide enough to catch a first import, which is usually a few months. The
  // same "last 3 months" every date picker opens on, and named by its dates:
  // this said "the last 90 days" while Cash Flow meant something else.
  const window3 = useMemo(() => defaultRange(), []);
  const range = { date_from: window3.from, date_to: window3.to };
  const { data: expenses } = useExpenses(range);

  useEffect(() => {
  }, []);

  if (isLoading || !summary) {
    return <p className="text-sm text-muted-foreground">Adding it up…</p>;
  }

  const txnCount = txns?.total ?? 0;
  const top = [...(expenses?.by_category ?? [])]
    // "Uncategorized" is a to-do, not an insight; the guide's categorize step
    // deals with it.
    // Real categories are children of "Expense", so a top-level-only filter
    // (which is what this had) left the list empty for every real import.
    .filter(
      (c) =>
        c.total !== 0 &&
        c.category_id != null &&
        c.category_name.toLowerCase() !== "uncategorized",
    )
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, 3);
  const debt = Math.abs(summary.total_liabilities);

  return (
    <>
    <div className="space-y-5 max-w-xl">
      <Stat label="Net worth" value={formatCurrency(summary.net_worth)} strong />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Cash" value={formatCurrency(summary.total_cash)} />
        <Stat label="Investments" value={formatCurrency(summary.investment_value)} />
        <Stat label="Debt" value={formatCurrency(debt)} />
      </div>

      <p className="text-sm text-muted-foreground">
        {txnCount === 0
          ? "No transactions yet. Import a file from the previous step to see your spending."
          : `${txnCount.toLocaleString()} ${txnCount === 1 ? "transaction" : "transactions"} imported.`}
      </p>

      {top.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm font-medium">Where the most money went, {formatRangeDates(window3)}</p>
          <ul className="mt-3 space-y-2 text-sm">
            {top.map((c) => (
              <li key={c.category_id ?? c.category_name} className="flex items-center gap-3">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground"
                  style={c.color ? { backgroundColor: c.color } : undefined}
                />
                <span className="flex-1 truncate">{c.category_name}</span>
                <span className="tabular-nums">{formatCurrency(Math.abs(c.total))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="text-sm font-medium mb-3">
          {onNext ? "Or jump straight into the app" : "Where do you want to go next?"}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* The portfolio leads: it is the finished picture of what was
              just imported, with nothing left to set up. */}
          <NextCard
            recommended={!onNext}
            icon={PieChart}
            title="See my portfolio"
            body="Net worth, allocation and holdings, built from the accounts you just added."
            onClick={() => go("portfolio")}
          />
          <NextCard
            icon={LayoutDashboard}
            title="Build my dashboard"
            body="Choose the widgets you see every day. Paiso suggests a few for your accounts and show you how to arrange them."
            onClick={() => go("dashboard")}
          />
        </div>
      </div>
    </div>
    <StepActions onBack={onBack}>
      {onNext && (
        <button onClick={onNext} className={primaryBtn}>
          Continue setup
        </button>
      )}
    </StepActions>
    </>
  );
}

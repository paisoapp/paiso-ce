import { Check, Minus, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useBudgetHistory, type HistoryMonth, type MonthStatus } from "@/hooks/useBudgetPlan";

const STATUS: Record<MonthStatus, { fill: string; ring: string; text: string; Icon: typeof Check; label: string }> = {
  excelled: { fill: "bg-[hsl(142,71%,45%)]/15", ring: "ring-[hsl(142,71%,45%)]", text: "text-[hsl(142,71%,40%)] dark:text-[hsl(142,71%,55%)]", Icon: Check, label: "On budget" },
  struggled: { fill: "bg-amber-500/15", ring: "ring-amber-500", text: "text-amber-600 dark:text-amber-400", Icon: Minus, label: "Slightly over" },
  failed: { fill: "bg-destructive/15", ring: "ring-destructive", text: "text-destructive", Icon: X, label: "Over budget" },
  none: { fill: "bg-muted/50", ring: "ring-border", text: "text-muted-foreground", Icon: Minus, label: "No activity" },
  no_budget: { fill: "bg-transparent", ring: "ring-border", text: "text-muted-foreground/50", Icon: Minus, label: "No budget" },
};

function tooltipFor(m: HistoryMonth): string {
  const head = `${m.label} ${m.year} · ${STATUS[m.status].label}`;
  if (m.status === "none") return `${head}\nNo budgeted spend recorded`;
  // Not graded, but its spending is given, as the month itself shows it.
  if (m.status === "no_budget") {
    return m.before_start && m.total_spent > 0
      ? `${m.label} ${m.year} · Before this budget started\n${formatCurrency(m.total_spent)} spent, for comparison`
      : `${head}\nBefore this budget started`;
  }
  const pct = m.ratio != null ? ` (${Math.round(m.ratio * 100)}%)` : "";
  return `${head}\n${formatCurrency(m.total_spent)} of ${formatCurrency(m.total_budget)}${pct}`;
}

export function MonthStrip({
  selectedMonth,
  onSelect,
}: {
  selectedMonth: string;
  onSelect: (month: string) => void;
}) {
  const { data, isLoading } = useBudgetHistory(12);
  if (isLoading || !data?.months?.length) return null;

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-muted-foreground">Last 12 months</span>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[hsl(142,71%,45%)]" /> On budget</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Over</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-destructive" /> Way over</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        {data.months.map((m) => {
          const s = STATUS[m.status];
          const selected = m.month === selectedMonth;
          const { Icon } = s;
          return (
            <button
              key={m.month}
              onClick={() => onSelect(m.month)}
              title={tooltipFor(m)}
              className={`group flex-1 min-w-0 rounded-lg ${s.fill} px-1 py-1.5 flex flex-col items-center gap-0.5 transition-all hover:brightness-110 ${
                selected ? `ring-2 ${s.ring}` : "ring-1 ring-transparent"
              }`}
            >
              <Icon size={13} className={s.text} strokeWidth={2.5} />
              <span className={`text-[11px] leading-none ${selected ? "font-semibold text-foreground" : "text-muted-foreground"}`}>
                {m.label}
              </span>
              {m.is_current && <span className="h-0.5 w-3 rounded-full bg-foreground/40" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

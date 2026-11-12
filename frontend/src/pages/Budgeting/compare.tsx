import { CategoryIcon } from "@/lib/categoryIcons";
import { type DateRange, formatRangeDates } from "@/components/ui/DateRangePicker";
import type { CategoryTotal } from "@/hooks/useBudget";
import { cn, formatCurrency } from "@/lib/utils";

/** Which way is good news: more income is, more spending is not. */
type Direction = "up-is-good" | "up-is-bad";

function changeClass(change: number, direction: Direction) {
  if (Math.abs(change) < 0.5) return "text-muted-foreground";
  const good = direction === "up-is-good" ? change > 0 : change < 0;
  return good ? "text-success" : "text-destructive";
}

function formatChange(now: number, before: number): string {
  const change = now - before;
  if (Math.abs(change) < 0.5) return "no change";
  const amount = `${change > 0 ? "+" : "−"}${formatCurrency(Math.abs(change))}`;
  // No percentage from a zero base: "up infinity percent" says nothing.
  if (before === 0) return amount;
  return `${amount} (${change > 0 ? "+" : "−"}${Math.abs((change / before) * 100).toFixed(0)}%)`;
}

/** "vs $4,000.00 · +$600.00 (+15%)" — the comparison in one line, for a
 *  headline or a stat card. Both figures are magnitudes, as displayed. */
export function CompareLine({ now, before, direction, className }: {
  now: number;
  before: number;
  direction: Direction;
  className?: string;
}) {
  return (
    <span className={cn("text-xs text-muted-foreground tabular-nums", className)}>
      vs {formatCurrency(before)}{" · "}
      <span className={changeClass(now - before, direction)}>{formatChange(now, before)}</span>
    </span>
  );
}

/**
 * Category-by-category comparison of two periods.
 *
 * Lists every category that appears in either. It used to list only the
 * current period's, so a category that had been spent on before and not since
 * — the clearest change there is — was missing from the table and from no
 * total.
 */
export function CompareTable({ heading, current, prior, currentRange, priorRange, direction, colorOf }: {
  /** Label for the first column: "Category" or "Source". */
  heading: string;
  current: CategoryTotal[];
  prior: CategoryTotal[];
  currentRange: DateRange | null;
  priorRange: DateRange;
  direction: Direction;
  colorOf: (categoryId: number | null) => string;
}) {
  const byId = new Map<number | null, { name: string; now: number; before: number }>();
  for (const r of current) {
    byId.set(r.category_id, { name: r.category_name, now: Math.abs(r.total), before: 0 });
  }
  for (const r of prior) {
    const row = byId.get(r.category_id) ?? { name: r.category_name, now: 0, before: 0 };
    row.before = Math.abs(r.total);
    byId.set(r.category_id, row);
  }
  const rows = [...byId.entries()]
    .map(([id, r]) => ({ id, ...r }))
    .filter((r) => r.now !== 0 || r.before !== 0)
    .sort((a, b) => b.now - a.now || b.before - a.before);
  if (rows.length === 0) return null;

  const totalNow = rows.reduce((s, r) => s + r.now, 0);
  const totalBefore = rows.reduce((s, r) => s + r.before, 0);
  const th = "px-4 py-2.5 font-medium text-muted-foreground";
  const amountClass = direction === "up-is-good" ? "text-success" : "text-destructive";

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted border-b border-border">
          <tr>
            <th className={cn(th, "text-left")}>{heading}</th>
            <th className={cn(th, "text-right whitespace-nowrap")}>{currentRange ? formatRangeDates(currentRange) : "All time"}</th>
            <th className={cn(th, "text-right whitespace-nowrap")}>{formatRangeDates(priorRange)}</th>
            <th className={cn(th, "text-right")}>Change</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.id ?? "uncat"} className="hover:bg-muted/30">
              <td className="px-4 py-2.5">
                {/* The glyph carries the chart series colour, so it names
                    the category and keys it to the pie in one mark. */}
                <div className="flex items-center gap-2">
                  <CategoryIcon name={row.name ?? "Uncategorized"} size={15} className="shrink-0" style={{ color: colorOf(row.id) }} />
                  {row.name}
                </div>
              </td>
              <td className={cn("px-4 py-2.5 text-right tabular-nums font-medium", row.now ? amountClass : "text-muted-foreground")}>
                {row.now ? formatCurrency(row.now) : "—"}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                {row.before ? formatCurrency(row.before) : "—"}
              </td>
              <td className={cn("px-4 py-2.5 text-right tabular-nums text-xs whitespace-nowrap", changeClass(row.now - row.before, direction))}>
                {formatChange(row.now, row.before)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-border">
          <tr>
            <td className="px-4 py-2.5 font-semibold">Total</td>
            <td className={cn("px-4 py-2.5 text-right tabular-nums font-semibold", amountClass)}>{formatCurrency(totalNow)}</td>
            <td className="px-4 py-2.5 text-right tabular-nums font-medium text-muted-foreground">{formatCurrency(totalBefore)}</td>
            <td className={cn("px-4 py-2.5 text-right tabular-nums text-xs font-medium whitespace-nowrap", changeClass(totalNow - totalBefore, direction))}>
              {formatChange(totalNow, totalBefore)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// dashboard-catalog: not offered, one category's last six months inside the Budget tab's Allocated pop-up
import { useState } from "react";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { MoneyInput } from "@/components/ui/MoneyInput";
import { useCategoryDetail, type ProgressLine } from "@/hooks/useBudgetPlan";
import { formatCompact, formatCurrency } from "@/lib/utils";
import { Pencil } from "@/lib/icons";
import { Popover } from "./Popover";
import { ScopeChoice, monthName } from "./ScopeChoice";
import { useDraft, wholeDiff } from "./budgetDraft";


/**
 * The Allocated figure. Clicking it opens the last six months
 * of spending, last month and the average (each fills the field), and a choice
 * of this month only or this month and later. Past months keep the amounts
 * they had, so there the figure is plain text.
 */
export function AllocatedCell({ line, month, editable }: { line: ProgressLine; month: string; editable: boolean }) {
  const [open, setOpen] = useState(false);
  const oneMonth = line.one_month && (
    <span className="block text-[10px] leading-tight text-primary" title="A change for this month only">
      {monthName(month)} only
    </span>
  );
  if (!editable) {
    return (
      <span className="text-sm tabular-nums">
        {formatCurrency(line.budgeted)}
        {oneMonth}
      </span>
    );
  }
  return (
    <>
    <Popover
      open={open}
      onOpenChange={setOpen}
      label={`${line.name}: allocated for ${monthName(month)}`}
      align="right"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Allocated for ${line.name}, ${formatCurrency(line.budgeted)}. Change it`}
          title="Click to change"
          // Drawn as a field, so it reads as something to type into.
          className="group inline-flex min-w-[6rem] items-center justify-between gap-2 rounded-md border border-border bg-background px-2 py-1 text-sm shadow-sm transition-colors hover:border-primary/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <Pencil size={12} className="text-muted-foreground group-hover:text-primary" aria-hidden />
          <span className="tabular-nums">{formatCurrency(line.budgeted)}</span>
        </button>
      }
    >
      {open && <AllocatedForm line={line} month={month} onDone={() => setOpen(false)} />}
    </Popover>
    {oneMonth}
    </>
  );
}

const CHIP = "inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground";

function AllocatedForm({ line, month, onDone }: { line: ProgressLine; month: string; onDone: () => void }) {
  const { data, isLoading } = useCategoryDetail(line.category_id, month);
  const { stage } = useDraft();
  const [text, setText] = useState(line.budgeted ? String(line.budgeted) : "");
  const [scope, setScope] = useState<"onward" | "month">(line.one_month ? "month" : "onward");
  const amount = Number(text) || 0;
  // A month picked on the chart, to see what made it up.
  // Last month starts picked, so the list under the chart shows what a bar
  // does before anyone has to find out. `undefined` is "not
  // chosen yet"; `null` is "closed".
  const [chosen, setPicked] = useState<string | null | undefined>(undefined);
  const picked = chosen === undefined ? data?.history[data.history.length - 1]?.month ?? null : chosen;

  // Staged with the tab's other changes; nothing is stored until Save.
  const save = () => {
    if (amount !== line.budgeted || scope !== (line.one_month ? "month" : "onward")) {
      stage({
        kind: "line", categoryId: line.category_id, edit: { amount, scope, month },
        label: `${line.name} to ${formatCurrency(amount)}${scope === "month" ? ` for ${monthName(month)} only` : ""}`,
      });
    }
    onDone();
  };

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => { e.preventDefault(); save(); }}
    >
      <div>
        <p className="text-xs text-muted-foreground mb-1">
          Spent in the last six months · <span className="text-foreground">pick a month to see its transactions</span>
        </p>
        <div className="h-28">
          {isLoading || !data ? (
            <div className="h-full rounded-md bg-muted/50 animate-pulse" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.history} margin={{ top: 20, right: 4, bottom: 0, left: 4 }}>
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))" }}
                  formatter={(v: number) => [formatCurrency(v), "Spent"]}
                  contentStyle={{ fontSize: 12 }}
                />
                {amount > 0 && <ReferenceLine y={amount} stroke="hsl(var(--foreground))" strokeDasharray="3 3" strokeOpacity={0.5} />}
                <Bar dataKey="spent" radius={[3, 3, 0, 0]} cursor="pointer"
                  onClick={(d: { month?: string }) => d.month && setPicked(picked === d.month ? null : d.month)}>
                  {data.history.map((h) => (
                    <Cell key={h.month} fill="hsl(var(--primary))" fillOpacity={picked && picked !== h.month ? 0.35 : 1} />
                  ))}
                  {/* Each month's amount over its bar, so the bars read as buttons with values. */}
                  <LabelList dataKey="spent" position="top" fontSize={10} fill="hsl(var(--foreground))"
                    formatter={(v: number) => (v <= 0 ? "" : v < 1000 ? `$${Math.round(v)}` : `$${formatCompact(v)}`)} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        {picked && <MonthTransactions categoryId={line.category_id} month={picked} onClose={() => setPicked(null)} />}
      </div>
      {data && (
        // Quick fills as one compact row of chips: each fills the field.
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => setText(String(Math.round(data.last_month)))}
            title="What you spent here last month"
            className={CHIP}>
            Last month <span className="tabular-nums font-medium">{formatCurrency(data.last_month)}</span>
          </button>
          <button type="button" onClick={() => setText(String(Math.round(data.average)))}
            title="Your average month over the last six"
            className={CHIP}>
            Avg <span className="tabular-nums font-medium">{formatCurrency(data.average)}</span>
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">$</span>
        <MoneyInput
          autoFocus
          allowNegative={false}
          value={text}
          onValueChange={setText}
          placeholder="0"
          aria-label={`Allocated for ${line.name}`}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-right tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </div>
      <ScopeChoice month={month} value={scope} onChange={setScope} />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="px-3 py-1.5 text-xs rounded-md border border-border hover:bg-muted">
          Cancel
        </button>
        <button type="submit"
          className="px-3 py-1.5 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50">
          Apply
        </button>
      </div>
    </form>
  );
}

/** How many of a month's transactions show before "Show all". */
const FIRST = 3;

/** One month's transactions for a category, under the Allocated pop-up's
 *  chart: the first few, and the rest on "Show all". */
function MonthTransactions({ categoryId, month, onClose }: { categoryId: number; month: string; onClose: () => void }) {
  const { data, isLoading } = useCategoryDetail(categoryId, month);
  const [all, setAll] = useState(false);
  const rows = data?.transactions ?? [];
  const shown = all ? rows : rows.slice(0, FIRST);
  const total = rows.reduce((s, t) => s + t.amount, 0);
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 px-2.5 py-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{monthName(month)}{rows.length > 0 && ` · ${rows.length} transaction${rows.length === 1 ? "" : "s"}`}</span>
        <button type="button" onClick={onClose} className="text-muted-foreground hover:text-foreground">Hide</button>
      </div>
      {isLoading ? (
        <div className="mt-2 h-10 rounded bg-muted/50 animate-pulse" />
      ) : rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">Nothing spent here in {monthName(month)}.</p>
      ) : (
        <>
          <ul className="mt-1 divide-y divide-border">
            {shown.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-1 text-xs">
                <span className="w-11 shrink-0 text-muted-foreground tabular-nums">
                  {new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
                <span className="flex-1 min-w-0 truncate">{t.description || "Transaction"}</span>
                <span className={`tabular-nums ${t.amount < 0 ? "text-success" : ""}`}>
                  {t.amount < 0 ? `+${formatCurrency(-t.amount)}` : formatCurrency(t.amount)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex items-center justify-between text-xs">
            {rows.length > FIRST ? (
              <button type="button" onClick={() => setAll((a) => !a)} className="text-primary hover:underline">
                {all ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            ) : <span />}
            <span className="tabular-nums font-medium">{formatCurrency(total)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** The Used figure: hovering (or tapping) lists the month's
 *  transactions that make it up. */
export function UsedCell({ line, month }: { line: ProgressLine; month: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      hover
      label={`${line.name}: used in ${monthName(month)}`}
      align="right"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={`Used for ${line.name}, ${formatCurrency(line.actual)}. Show transactions`}
          className="rounded-md px-1 text-sm tabular-nums hover:bg-muted"
        >
          {formatCurrency(line.actual)}
        </button>
      }
    >
      {open && <UsedList line={line} month={month} />}
    </Popover>
  );
}

function UsedList({ line, month }: { line: ProgressLine; month: string }) {
  const { data, isLoading } = useCategoryDetail(line.category_id, month);
  if (isLoading || !data) return <div className="h-16 rounded-md bg-muted/50 animate-pulse" />;
  if (data.transactions.length === 0) {
    return <p className="text-xs text-muted-foreground">Nothing spent here in {monthName(month)} yet.</p>;
  }
  return (
    <div className="text-sm">
      <ul className="divide-y divide-border">
        {data.transactions.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-xs text-muted-foreground w-12 shrink-0 tabular-nums">
              {new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
            <span className="flex-1 min-w-0 truncate">{t.description || "Transaction"}</span>
            <span className={`tabular-nums ${t.amount < 0 ? "text-success" : ""}`}>
              {t.amount < 0 ? `+${formatCurrency(-t.amount)}` : formatCurrency(t.amount)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 flex justify-between border-t border-border pt-2 text-xs font-medium">
        <span>Used</span>
        <span className="tabular-nums">{formatCurrency(line.actual)}</span>
      </p>
    </div>
  );
}

/** The Remaining figure: Allocated less Used, in whole dollars. */
export function RemainingCell({ line }: { line: ProgressLine }) {
  // Allocated less Used as shown, in whole dollars, so the row adds up.
  const shown = wholeDiff(line.available, line.actual);
  const over = shown < 0;
  return (
    <span className={`text-sm tabular-nums ${over ? "text-destructive font-medium" : ""}`}>
      {formatCurrency(shown)}
    </span>
  );
}

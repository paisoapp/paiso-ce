/**
 * The budget-wide rollover switch, on the new-budget screen
 * and in Budget settings. With categories set one by one, `mixed` says how
 * many are on. Rollover counts from the month it is turned on.
 */
export function RolloverSwitch({ on, onChange, mixed }: {
  on: boolean;
  onChange: (on: boolean) => void;
  /** Categories with rollover on, of all of them, when they differ. */
  mixed?: { on: number; of: number };
}) {
  return (
    <label className="flex items-start gap-3 rounded-lg border border-border p-3 cursor-pointer hover:bg-muted/40 transition-colors">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[hsl(var(--primary))]" />
      <span>
        <span className="block text-sm font-medium">Roll over what is left or overspent into next month</span>
        <span className="block text-xs text-muted-foreground">
          Money left in a category adds to its next month, and overspending takes from it. It counts from this
          month on. You can still turn it on or off for one category from its menu on the Budget tab.
        </span>
        {mixed && <span className="mt-1 block text-xs font-medium">On for {mixed.on} of {mixed.of} categories now.</span>}
      </span>
    </label>
  );
}

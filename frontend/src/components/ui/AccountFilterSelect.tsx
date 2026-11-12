import { cn } from "@/lib/utils";

/**
 * The "All accounts" filter that sits in a page toolbar.
 *
 * A native `<select>` is as wide as its widest option, so a single account
 * with a long name, such as a full 401(k) plan title, stretched the control across
 * the entire toolbar on Budgeting, Transactions and Investments — the same
 * markup had been copied into six pages, so it was the same bug six times.
 * The width is capped and the closed label ellipsized here; the open dropdown
 * is drawn by the browser at its own width and still shows names in full.
 */
export function AccountFilterSelect({
  value,
  onChange,
  accounts,
  label = "Filter by account",
  className,
}: {
  /** The selected account id, or undefined / "" for all of them. */
  value: number | "" | undefined;
  onChange: (id: number | undefined) => void;
  accounts: { id: number; name: string }[];
  /** Accessible name; these selects have no visible label. */
  label?: string;
  className?: string;
}) {
  return (
    <select
      value={value ?? ""}
      aria-label={label}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      className={cn(
        "truncate rounded-md border border-border bg-background px-3 py-1.5 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-primary/50",
        // Full width on a phone, where the toolbar stacks anyway; capped on
        // desktop so one long account name cannot set the toolbar's layout.
        "w-full sm:w-auto sm:max-w-[13rem]",
        className,
      )}
    >
      <option value="">All accounts</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

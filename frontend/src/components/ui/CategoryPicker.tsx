import { useCategories } from "@/hooks/useCategories";
import { cn } from "@/lib/utils";

// Sentinel for the "Unchanged" option (bulk edit) — distinct from "" so
// it doesn't collide with the "no category" value.
const UNCHANGED = "__unchanged__";

interface CategoryPickerProps {
  value: number | null | undefined;
  onChange: (id: number | null | undefined) => void;
  /** "inline" = compact select for table rows; "full" = full-width for drawer */
  variant?: "inline" | "full";
  /** Adds a leading "Unchanged" option (value undefined) for bulk-edit
   *  contexts, where leaving the field untouched is a distinct choice from
   *  clearing the category. */
  allowUnchanged?: boolean;
}

export function CategoryPicker({
  value,
  onChange,
  variant = "inline",
  allowUnchanged = false,
}: CategoryPickerProps) {
  const { data: categories = [] } = useCategories();

  const sort = (arr: typeof categories) =>
    [...arr].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    );

  const roots = categories.filter((c) => c.parent_id === null);
  const childrenOf = (parentId: number) =>
    sort(categories.filter((c) => c.parent_id === parentId));

  const incomeParent = roots.find((c) => c.is_income && c.name === "Income");
  const expenseParent = roots.find((c) => !c.is_income && c.name === "Expense");

  const incomeOptions = incomeParent
    ? childrenOf(incomeParent.id)
    : sort(roots.filter((c) => c.is_income && !/transfer/i.test(c.name)));

  const expenseOptions = expenseParent
    ? childrenOf(expenseParent.id)
    : sort(
        roots.filter(
          (c) =>
            !c.is_income &&
            !/transfer/i.test(c.name) &&
            !/uncategorized/i.test(c.name)
        )
      );

  const transferParent = roots.find((c) => /^transfer$/i.test(c.name));
  const transferOptions = transferParent ? childrenOf(transferParent.id) : [];

  const selectValue = value === undefined ? UNCHANGED : value === null ? "" : String(value);

  return (
    <select
      value={selectValue}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === UNCHANGED ? undefined : v ? Number(v) : null);
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-primary/50",
        variant === "inline"
          ? "px-2 py-1 text-xs"
          : "w-full px-3 py-2 text-sm"
      )}
    >
      {allowUnchanged && <option value={UNCHANGED}>Unchanged</option>}
      <option value="">{allowUnchanged ? "Remove category" : "Uncategorized"}</option>
      {incomeOptions.length > 0 && (
        <optgroup label="── Income">
          {incomeOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
      {expenseOptions.length > 0 && (
        <optgroup label="── Expense">
          {expenseOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
      {(transferOptions.length > 0 || transferParent) && (
        <optgroup label="── Transfer">
          {transferOptions.length > 0 ? (
            transferOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))
          ) : (
            transferParent && (
              <option value={transferParent.id}>Transfer</option>
            )
          )}
        </optgroup>
      )}
    </select>
  );
}

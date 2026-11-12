import { CheckCircle } from "@/lib/icons";
import { cn } from "@/lib/utils";
import type { Option } from "../recommend";

/**
 * A tappable answer. `tile` is the large card with an icon and a line of
 * explanation, for the question a screen is about; `chip` is the compact one
 * for a longer list of short answers.
 */
export function OptionCard({
  option, selected, onClick, variant = "tile",
}: {
  option: Option;
  selected: boolean;
  onClick: () => void;
  variant?: "tile" | "chip";
}) {
  const Icon = option.icon;
  if (variant === "chip") {
    return (
      <button
        type="button"
        aria-pressed={selected}
        onClick={onClick}
        className={cn(
          "flex items-center gap-2.5 rounded-lg border px-3.5 py-3 text-left text-sm transition-colors",
          selected ? "border-primary bg-primary/10 font-medium" : "border-border bg-card hover:bg-muted",
        )}
      >
        {Icon && (
          <Icon className={cn("h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} />
        )}
        <span className="flex-1">{option.label}</span>
        {selected && <CheckCircle className="h-4 w-4 shrink-0 text-primary" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-start gap-3 rounded-xl border p-4 text-left transition-colors",
        selected
          ? "border-primary bg-primary/10 ring-1 ring-primary"
          : "border-border bg-card hover:border-primary/40 hover:bg-muted/50",
      )}
    >
      {selected && <CheckCircle className="absolute right-3 top-3 h-5 w-5 text-primary" />}
      {Icon && (
        <span
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg",
            selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
      )}
      <span>
        <span className="block text-sm font-medium">{option.label}</span>
        {option.hint && (
          <span className="mt-0.5 block text-xs text-muted-foreground">{option.hint}</span>
        )}
      </span>
    </button>
  );
}

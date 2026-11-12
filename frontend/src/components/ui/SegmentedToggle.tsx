import type { ComponentType } from "react";
import { chartToggleStyle } from "@/lib/chartToggleStyle";

/** A row of mutually exclusive choices, as used to switch a chart's type.
 *  An option with an `icon` can show it in place of its label (the label
 *  stays as its tooltip and its name for screen readers). */
export function SegmentedToggle<T extends string>({
  value,
  options,
  onChange,
  fill = false,
}: {
  value: T;
  options: { value: T; label: string; icon?: ComponentType<{ className?: string }> }[];
  onChange: (v: T) => void;
  /** Stretch across the row, the options sharing it equally. */
  fill?: boolean;
}) {
  const icons = chartToggleStyle() === "icons";
  return (
    <div role="group" className={`flex rounded-md overflow-hidden border border-border ${fill ? "w-full divide-x divide-border" : ""}`}>
      {options.map((o) => {
        const Icon = icons ? o.icon : undefined;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={value === o.value}
            aria-label={Icon ? o.label : undefined}
            title={Icon ? o.label : undefined}
            onClick={() => onChange(o.value)}
            className={`${Icon ? "px-2 py-1" : "px-2.5 py-1 text-xs"} ${fill ? "flex-1 text-center" : ""} transition-colors ${value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
          >
            {Icon ? <Icon className="h-4 w-4" /> : o.label}
          </button>
        );
      })}
    </div>
  );
}

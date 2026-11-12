import { useState } from "react";
import { Info } from "@/lib/icons";
import { SegmentedToggle } from "@/components/ui/SegmentedToggle";

export type AmountScope = "onward" | "month";

export function monthName(month: string): string {
  return new Date(month + "-15").toLocaleDateString("en-US", { month: "long" });
}

/**
 * "October and later" or "October only", with an "i" that explains the
 * choice inline. Shared by the Allocated pop-up and Budget settings.
 * `what` names what is being set, for the explanation ("this amount").
 */
export function ScopeChoice({
  month,
  value,
  onChange,
  what = "this amount",
}: {
  month: string;
  value: AmountScope;
  onChange: (v: AmountScope) => void;
  what?: string;
}) {
  const [hint, setHint] = useState(false);
  const name = monthName(month);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Apply to</span>
        <button
          type="button"
          onClick={() => setHint((h) => !h)}
          aria-expanded={hint}
          aria-label="What these options do"
          title="What these options do"
          className={`rounded-full p-0.5 ${hint ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          <Info size={14} />
        </button>
      </div>
      {hint && (
        <div className="rounded-md bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground space-y-1">
          <p>
            <span className="font-medium text-foreground">{name} and later</span> sets {what} for {name} and every
            month after it, until you change it again.
          </p>
          <p>
            <span className="font-medium text-foreground">{name} only</span> sets it for {name} alone. The next month
            goes back to the usual amount.
          </p>
          <p>Either way, earlier months keep the amounts they had.</p>
        </div>
      )}
      <SegmentedToggle
        fill
        value={value}
        onChange={onChange}
        options={[
          { value: "onward", label: `${name} and later` },
          { value: "month", label: `${name} only` },
        ]}
      />
    </div>
  );
}

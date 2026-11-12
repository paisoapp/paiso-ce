import { MAX_SLOTS, neutral, slotColor } from "@/lib/chartPalette";

/** Display names for the portfolio summary's `asset_breakdown` labels. */
const ASSET_LABELS: Record<string, string> = {
  cash: "Cash",
  brokerage: "Brokerage",
  "401k": "401(k)",
  ira: "IRA",
  roth_ira: "Roth IRA",
  hsa: "HSA",
  "529": "529 Plan",
  other_investments: "Other Investments",
  property: "Property",
  other_assets: "Other Assets",
};

/** Canonical order. Hues are handed out along it — by identity, never by
 *  size — so Brokerage keeps its colour as balances move around it. */
const ORDER = Object.keys(ASSET_LABELS);

interface AssetSlice {
  key: string;
  label: string;
  value: number;
  color: string;
}

/**
 * Colour the asset-breakdown slices from the shared validated palette.
 *
 * The palette has eight hues and they are never cycled, so past eight
 * slices the smallest fold into a neutral "Other" — the same rule the
 * Budgeting charts follow. Slices always sum to the input total.
 */
export function assetSlices(
  breakdown: { label: string; value: number }[],
  dark: boolean,
): AssetSlice[] {
  const rank = (k: string) => {
    const i = ORDER.indexOf(k);
    return i === -1 ? ORDER.length : i;
  };
  const present = breakdown.filter((b) => b.value > 0);

  let kept = present;
  let folded = 0;
  if (present.length > MAX_SLOTS) {
    const bySize = [...present].sort((a, b) => b.value - a.value);
    kept = bySize.slice(0, MAX_SLOTS - 1);
    folded = bySize.slice(MAX_SLOTS - 1).reduce((s, b) => s + b.value, 0);
  }

  const slices: AssetSlice[] = [...kept]
    .sort((a, b) => rank(a.label) - rank(b.label))
    .map((b, i) => ({
      key: b.label,
      label: ASSET_LABELS[b.label] ?? b.label,
      value: b.value,
      color: slotColor(i, dark),
    }));
  if (folded > 0) {
    slices.push({ key: "other", label: "Other", value: folded, color: neutral(dark) });
  }
  return slices;
}

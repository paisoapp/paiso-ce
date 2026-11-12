/** Shared categorical palette for every chart (Budgeting, Portfolio, Dashboard).
 *
 * Eight hues in a **fixed order**, validated in both modes: every adjacent pair
 * clears the colour-vision-deficiency separation floor (worst ΔE 9.1 light /
 * 8.4 dark under protanopia and deuteranopia) and the normal-vision floor
 * (19.6 / 19.3). The order is the safety mechanism, so it never changes and is
 * never cycled — a ninth category folds into "Other" rather than reusing a hue,
 * which is what `MAX_VISIBLE` in the Sankey enforces.
 *
 * Three light-mode slots sit below 3:1 against the surface. That is legal only
 * because every mark in these charts is directly labelled with its name and
 * amount, so identity never rests on colour alone.
 */
interface Slot {
  light: string;
  dark: string;
}

const CAT_SLOTS: Slot[] = [
  { light: "#2a78d6", dark: "#3987e5" },  // blue
  { light: "#eb6834", dark: "#d95926" },  // orange
  { light: "#1baf7a", dark: "#199e70" },  // aqua
  { light: "#eda100", dark: "#c98500" },  // yellow
  { light: "#e87ba4", dark: "#d55181" },  // magenta
  { light: "#008300", dark: "#008300" },  // green
  { light: "#4a3aa7", dark: "#9085e9" },  // violet
  { light: "#e34948", dark: "#e66767" },  // red
];

/** How many distinct hues exist. Past this, fold into "Other". */
export const MAX_SLOTS = CAT_SLOTS.length;

/** Neutral, deliberately outside the categorical order so it can never be
 *  mistaken for a category. */
const NEUTRAL = { light: "#6b7280", dark: "#9ca3af" };

export function slotColor(index: number, dark: boolean): string {
  const slot = CAT_SLOTS[Math.min(index, MAX_SLOTS - 1)];
  return dark ? slot.dark : slot.light;
}

export function neutral(dark: boolean): string {
  return dark ? NEUTRAL.dark : NEUTRAL.light;
}

/**
 * Map categories to palette slots by **identity, not rank**.
 *
 * Colour has to follow the entity: if slots were handed out in the order rows
 * arrive — which is sorted by amount — then a month where groceries outspent
 * rent would repaint both, and the same category would be a different colour
 * in every period and in every chart. Sorting by category id first makes the
 * assignment stable for a given set of categories, so a category keeps its
 * colour as amounts move around it.
 *
 * `null` ids (the uncategorized bucket) are not assigned a hue at all; the
 * caller gives them the neutral.
 */
export function assignSlots(categoryIds: (number | null)[]): Map<number, number> {
  const ids = Array.from(
    new Set(categoryIds.filter((id): id is number => id != null))
  ).sort((a, b) => a - b);
  const out = new Map<number, number>();
  ids.forEach((id, i) => out.set(id, i));
  return out;
}

// Income and expenses are the one pair that is not a category: wherever the
// two are drawn against each other, money in is green and above the axis and
// money out is red and below it. Category slots are for telling categories
// apart, and gave this pair blue and orange.
export const INCOME_COLOR = "#22c55e";
export const EXPENSE_COLOR = "#ef4444";

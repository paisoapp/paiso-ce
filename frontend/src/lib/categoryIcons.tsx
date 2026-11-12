/**
 * Category → icon resolution.
 *
 * Categories carry an `icon` column, but every seeded child gets the generic
 * "circle", so in practice the transaction and budgeting lists were a wall of
 * identical dots. This maps the built-in category names (and the obvious
 * synonyms users rename them to) onto real glyphs.
 *
 * Resolution order, most specific first:
 *   1. exact match on the normalized category name
 *   2. keyword match, so "Dining Out" and "Restaurants & Bars" both find food
 *   3. the category's own stored `icon`, if it's a real lucide name
 *   4. a neutral dot
 *
 * Icons come from `@/lib/icons` rather than lucide directly so they pick up the
 * per-theme Phosphor treatment like every other icon in the app.
 */
import type { ComponentType, CSSProperties } from "react";
import * as Icons from "@/lib/icons";

type IconComponent = ComponentType<{
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}>;

/** "Health & Medical" → "health medical"; punctuation is noise for matching. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Exact names — the seeded defaults plus close variants.
const BY_NAME: Record<string, IconComponent> = {
  // Roots
  "income": Icons.TrendingUp,
  "expense": Icons.TrendingDown,
  "expenses": Icons.TrendingDown,
  "transfer": Icons.ArrowLeftRight,
  "uncategorized": Icons.HelpCircle,

  // Income
  "paychecks salary": Icons.Banknote,
  "salary": Icons.Banknote,
  "paycheck": Icons.Banknote,
  "investment income": Icons.LineChart,
  "business freelance": Icons.Briefcase,
  "gifts received": Icons.Gift,
  "other income": Icons.Coins,

  // Expenses
  "housing": Icons.Home,
  "utilities": Icons.Zap,
  "groceries": Icons.ShoppingCart,
  "restaurants": Icons.Utensils,
  "transportation": Icons.Car,
  "shopping": Icons.ShoppingBag,
  "health medical": Icons.Stethoscope,
  "personal care": Icons.Scissors,
  "entertainment": Icons.Film,
  "subscriptions": Icons.Repeat,
  "travel": Icons.Plane,
  "insurance": Icons.Umbrella,
  "fees charges": Icons.Receipt,
  "taxes": Icons.Landmark,
  "gifts donations": Icons.Gift,
  "other expenses": Icons.Circle,

  // Transfers
  "credit card payment": Icons.CreditCard,
  "savings": Icons.PiggyBank,
  "investments": Icons.TrendingUp,
  "retirement contributions": Icons.Landmark,
  "loan payment": Icons.Banknote,
  "refunds": Icons.RotateCcw,
  "reimbursement": Icons.RotateCcw,
};

/**
 * Keyword rules, checked in order — first hit wins, so the specific ones come
 * ahead of the general ("car insurance" should read as insurance, not car).
 *
 * Matching is per-word, never raw substring: "Childcare" and "Health Care" both
 * contain "car" and were resolving to a car glyph. Needles of 4+ characters may
 * match a word prefix ("grocer" → "groceries"); shorter ones must match a whole
 * word, which is why the plurals are listed explicitly.
 */
const PREFIX_MIN = 4;

const BY_KEYWORD: [string, IconComponent][] = [
  ["insurance", Icons.Umbrella],
  ["grocer", Icons.ShoppingCart],
  ["restaurant", Icons.Utensils],
  ["dining", Icons.Utensils],
  ["food", Icons.Utensils],
  ["coffee", Icons.Coffee],
  ["bar", Icons.Wine],
  ["bars", Icons.Wine],
  ["alcohol", Icons.Wine],
  ["rent", Icons.Home],
  ["mortgage", Icons.Home],
  ["home", Icons.Home],
  ["hous", Icons.Home],
  ["gas", Icons.Fuel],
  ["fuel", Icons.Fuel],
  ["parking", Icons.Car],
  ["transit", Icons.Bus],
  ["transport", Icons.Car],
  ["auto", Icons.Car],
  ["car", Icons.Car],
  ["cars", Icons.Car],
  ["vehicle", Icons.Car],
  ["shop", Icons.ShoppingBag],
  ["clothing", Icons.Shirt],
  ["apparel", Icons.Shirt],
  ["entertain", Icons.Film],
  ["movie", Icons.Film],
  ["stream", Icons.Tv],
  ["music", Icons.Music],
  ["game", Icons.Gamepad2],
  ["subscription", Icons.Repeat],
  ["phone", Icons.Smartphone],
  ["internet", Icons.Wifi],
  ["electric", Icons.Zap],
  ["water", Icons.Droplet],
  ["utilit", Icons.Zap],
  ["health", Icons.Stethoscope],
  ["medical", Icons.Stethoscope],
  ["doctor", Icons.Stethoscope],
  ["pharmac", Icons.Pill],
  ["fitness", Icons.Dumbbell],
  ["gym", Icons.Dumbbell],
  ["personal care", Icons.Scissors],
  ["pet", Icons.PawPrint],
  ["pets", Icons.PawPrint],
  ["child", Icons.Baby],
  ["kid", Icons.Baby],
  ["kids", Icons.Baby],
  ["education", Icons.GraduationCap],
  ["school", Icons.GraduationCap],
  ["tuition", Icons.GraduationCap],
  ["book", Icons.BookOpen],
  ["travel", Icons.Plane],
  ["flight", Icons.Plane],
  ["hotel", Icons.Plane],
  ["vacation", Icons.Plane],
  ["donation", Icons.Gift],
  ["charit", Icons.Gift],
  ["gift", Icons.Gift],
  ["tax", Icons.Landmark],
  ["taxes", Icons.Landmark],
  ["fee", Icons.Receipt],
  ["fees", Icons.Receipt],
  ["charge", Icons.Receipt],
  ["salary", Icons.Banknote],
  ["paycheck", Icons.Banknote],
  ["payroll", Icons.Banknote],
  ["freelance", Icons.Briefcase],
  ["business", Icons.Briefcase],
  ["invest", Icons.TrendingUp],
  ["saving", Icons.PiggyBank],
  ["retirement", Icons.Landmark],
  ["credit card", Icons.CreditCard],
  ["loan", Icons.Banknote],
  ["refund", Icons.RotateCcw],
  ["reimburse", Icons.RotateCcw],
  ["transfer", Icons.ArrowLeftRight],
  ["income", Icons.TrendingUp],
];

/** "shopping-bag" → "ShoppingBag", so a stored icon name can find its component. */
function pascal(kebab: string): string {
  return kebab.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase());
}

/**
 * Resolve the icon for a category. `storedIcon` is the category's own `icon`
 * column, used only when the name doesn't tell us anything more specific — it's
 * "circle" for every seeded child, which is what made the lists unreadable.
 */
function categoryIcon(name: string, storedIcon?: string | null): IconComponent {
  const key = normalize(name || "");

  const exact = BY_NAME[key];
  if (exact) return exact;

  const words = key.split(" ").filter(Boolean);
  for (const [needle, icon] of BY_KEYWORD) {
    // Multi-word needles ("credit card") are phrases — match them against the
    // whole normalized name, where the space already acts as a boundary.
    const hit = needle.includes(" ")
      ? key.includes(needle)
      : words.some(
          (w) => w === needle || (needle.length >= PREFIX_MIN && w.startsWith(needle)),
        );
    if (hit) return icon;
  }

  if (storedIcon && storedIcon !== "circle") {
    const fromStore = (Icons as Record<string, unknown>)[pascal(storedIcon)];
    if (typeof fromStore === "function") return fromStore as IconComponent;
  }

  return Icons.Circle;
}

/** Whether a stored `icon` is an emoji rather than an older icon name such as "circle". */
function isEmoji(icon?: string | null): icon is string {
  return !!icon && !/^[a-z0-9-]+$/.test(icon);
}

/** Convenience wrapper: the category's emoji when it has one, else the
 *  glyph resolved from its name. */
export function CategoryIcon({
  name,
  icon,
  size = 14,
  className,
  style,
}: {
  name: string;
  icon?: string | null;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  if (isEmoji(icon)) {
    return (
      <span
        aria-hidden
        className={className}
        style={{ fontSize: size, lineHeight: 1, width: size + 2, display: "inline-flex", justifyContent: "center", ...style }}
      >
        {icon}
      </span>
    );
  }
  const Glyph = categoryIcon(name, icon);
  return <Glyph size={size} className={className} style={style} />;
}

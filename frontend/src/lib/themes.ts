// Central theme registry — single source of truth for which visual themes exist
// and which are exposed to users. The actual color/radius/font values for each
// theme live in `src/index.css` under `[data-theme="<id>"]` blocks (plus `.dark`
// and `.gray` mode overrides). Adding a theme = add an entry here AND a CSS block.
//
// Visibility control: flip `enabled` to gate a theme without removing its CSS.
// `useTheme` validates the persisted id against the enabled list and falls back
// to `classic`, so disabling a theme never strands a user on it.

export type ThemeId =
  | "classic"
  | "swiss"
  | "editorial"
  | "civic"
  | "verdant-grove"
  | "terrazzo"
  | "kinetic-flux"
  | "atlas-console"
  | "pixel-art"
  | "plain";

interface ThemeDef {
  id: ThemeId;
  label: string;
  description: string;
  /** Config allowlist — set false to hide a theme from the picker. */
  enabled: boolean;
  /** Three representative colors (hex) rendered as a preview swatch. */
  swatch: [string, string, string];
}

const THEMES: ThemeDef[] = [
  {
    // Id kept as "classic" for back-compat with persisted user prefs; the
    // palette and label are the Paiso brand. See index.css.
    id: "classic",
    label: "Paiso",
    description: "The Paiso brand: deep greens in light, navy and gold in dark.",
    enabled: true,
    swatch: ["#285348", "#152e23", "#efb72a"],
  },
  {
    id: "swiss",
    label: "Swiss",
    description: "Clean grids, maximum clarity, zero decoration.",
    enabled: true,
    swatch: ["#ff0000", "#e5e5e5", "#ffffff"],
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Warm paper, serif headlines, print elegance.",
    enabled: true,
    swatch: ["#436f20", "#d4d0c8", "#faf8f5"],
  },
  {
    id: "civic",
    label: "Civic",
    description: "Institutional navy with confident gold accents.",
    enabled: true,
    swatch: ["#1a2744", "#e6a812", "#e2e6ed"],
  },
  {
    id: "verdant-grove",
    label: "Verdant Grove",
    description: "Soft green nature aesthetic, calm and organic.",
    enabled: true,
    swatch: ["#315c45", "#f0d8a8", "#eff6ef"],
  },
  {
    id: "terrazzo",
    label: "Terrazzo Atelier",
    description: "Warm studio palette of clay, sun and sage.",
    enabled: true,
    swatch: ["#d07a5f", "#f2c36b", "#fff7ed"],
  },
  {
    id: "kinetic-flux",
    label: "Kinetic Flux",
    description: "Cool surfaces with electric, motion-first accents.",
    enabled: true,
    swatch: ["#2bb3ff", "#7dff5a", "#f4f6fb"],
  },
  {
    id: "atlas-console",
    label: "Atlas Console",
    description: "Dense, high-clarity operations console.",
    enabled: true,
    swatch: ["#f59e0b", "#22d3ee", "#0f172a"],
  },
  {
    id: "pixel-art",
    label: "Pixel Art",
    description: "Retro 8-bit with a chunky NES-inspired palette.",
    enabled: true,
    swatch: ["#0077c0", "#fcbf00", "#0f0f0f"],
  },
  {
    id: "plain",
    label: "Plain",
    description: "No-nonsense black & white, serif type.",
    enabled: true,
    swatch: ["#000000", "#cccccc", "#ffffff"],
  },
];

// The Paiso theme. Existing accounts keep whatever they stored; this is what
// someone new lands on. Keep in step with the no-flash script in index.html
// and the column default in backend/app/models/settings.py.
const DEFAULT_THEME: ThemeId = "classic";

export const enabledThemes = (): ThemeDef[] => THEMES.filter((t) => t.enabled);

/** Resolve an arbitrary string to a usable, enabled theme id (falls back to default). */
export function resolveThemeId(id: string | null | undefined): ThemeId {
  const found = THEMES.find((t) => t.id === id && t.enabled);
  return found ? found.id : DEFAULT_THEME;
}

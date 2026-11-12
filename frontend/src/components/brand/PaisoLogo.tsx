import { cn } from "@/lib/utils";
import type { ThemeId } from "@/lib/themes";
import { useThemeStore } from "@/store/theme";

// One logo per theme: the supplied artwork trimmed and scaled to 256px (see
// assets/brand/README.md). Each import is a URL, so only the logo for the
// theme on screen is downloaded.
import atlasConsoleLogo from "@/assets/brand/themes/atlas-console.webp";
import civicLogo from "@/assets/brand/themes/civic.webp";
import editorialLogo from "@/assets/brand/themes/editorial.webp";
import kineticFluxLogo from "@/assets/brand/themes/kinetic-flux.webp";
import pixelArtLogo from "@/assets/brand/themes/pixel-art.webp";
import plainLogo from "@/assets/brand/themes/plain.webp";
import swissLogo from "@/assets/brand/themes/swiss.webp";
import terrazzoLogo from "@/assets/brand/themes/terrazzo.webp";
import verdantGroveLogo from "@/assets/brand/themes/verdant-grove.webp";

const THEME_LOGOS: Record<ThemeId, string> = {
  // The Paiso theme in dark and gray. Light is handled in `logoFor`.
  classic: verdantGroveLogo,
  swiss: swissLogo,
  editorial: editorialLogo,
  civic: civicLogo,
  "verdant-grove": verdantGroveLogo,
  terrazzo: terrazzoLogo,
  "kinetic-flux": kineticFluxLogo,
  "atlas-console": atlasConsoleLogo,
  "pixel-art": pixelArtLogo,
  plain: plainLogo,
};

/**
 * The logo for a theme and painted mode. The Paiso theme in light mode takes
 * the Swiss logo: its own deep green tile disappears into the deep green
 * sidebar that mode paints.
 */
function logoFor(themeId: ThemeId, resolved: "light" | "dark" | "gray"): string {
  if (themeId === "classic" && resolved === "light") return swissLogo;
  return THEME_LOGOS[themeId] ?? verdantGroveLogo;
}

/**
 * The Paiso mark: the supplied logo artwork for the active theme. Nothing is
 * redrawn; each theme's logo is used exactly as delivered.
 *
 * The rounded corners are transparent. `.paiso-mark` (src/index.css) traces
 * the tile with a faint edge in the surrounding text colour, so a tile the
 * same colour as the surface behind it (Swiss on white, Verdant Grove on its
 * dark sidebar) still reads as a tile.
 */
export function PaisoMark({ className }: { className?: string }) {
  const themeId = useThemeStore((s) => s.themeId);
  const resolved = useThemeStore((s) => s.resolved);
  return (
    <img
      src={logoFor(themeId, resolved)}
      alt=""
      aria-hidden
      className={cn("paiso-mark shrink-0 object-contain", className)}
    />
  );
}

/**
 * Full brand lockup: the mark + "paiso" wordmark. The wordmark keeps the
 * shared `.brand-wordmark`/`font-display` classes so it adopts each theme's
 * display font (pixel-art, editorial, …) — matching how the app has always
 * rendered its wordmark. Lowercase "paiso" mirrors the primary logo.
 */
export function PaisoLogo({
  className,
  markClassName,
  wordmarkClassName,
  showWordmark = true,
}: {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <PaisoMark className={cn("shrink-0", markClassName)} />
      {showWordmark && <Wordmark className={wordmarkClassName} />}
    </div>
  );
}

/**
 * The "paiso" wordmark with "Community Edition" on a small line beneath it,
 * so it is plain which edition is open: this one, which people run
 * themselves, or the hosted Paiso. Stacked, because the open sidebar is
 * 224px wide and the two do not fit on one line beside the mark.
 * `className` sizes the wordmark (text-lg in the sidebar and phone header).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className="flex min-w-0 flex-col leading-none" title={EDITION_TITLE}>
      <span className={cn("brand-wordmark font-display font-bold tracking-tight leading-none", className)}>paiso</span>
      <EditionBadge className="mt-1" />
    </span>
  );
}

const EDITION_TITLE = "Paiso Community Edition: the free, self-hosted edition";

/**
 * "Community Edition" under the wordmark. A label, not a new name: the
 * product is still Paiso (TRADEMARK.md).
 */
function EditionBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap font-sans text-[10px] font-semibold uppercase leading-none tracking-wide opacity-70",
        className,
      )}
    >
      Community Edition
    </span>
  );
}

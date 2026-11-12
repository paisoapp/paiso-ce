# Paiso brand assets

The Paiso identity. Each theme has its own logo under `themes/`, and
`PaisoMark` (`components/brand/PaisoLogo.tsx`) shows the one for the active
theme. `paiso-logo.png` is the original raster artwork; everything under
`public/` and `public/icons/` is that file scaled. Use the supplied files as
delivered: never redraw a logo, and never trace one into an SVG. A traced SVG
set was tried and looked grainy, with faint seams, at sidebar size.

## Which logo each theme shows

`logoFor` in `components/brand/PaisoLogo.tsx` decides. Every theme shows
`themes/<theme id>.webp`, with two exceptions:

- **Paiso (`classic`), light mode:** `themes/swiss.webp`. The Paiso light
  sidebar is deep green, and the Verdant Grove tile disappears into it.
- **Paiso (`classic`), dark and gray:** `themes/verdant-grove.webp`, the same
  artwork as `paiso-logo.png`.

The marketing site (`marketing/src/components/Logo.astro`) follows the same
rule, since it wears the Paiso theme.

## Files

| File | Purpose |
|---|---|
| `themes/source/*.webp` | **The theme logos as supplied**: 1254px, transparent corners. The source of truth for each theme. `plain` is the Plain Chaos artwork and `terrazzo` is Terrazzo Atelier. |
| `themes/*.webp` | Each source with its transparent margin trimmed, scaled to 256px. This is what `PaisoMark` imports; each is 7 to 16 KB, and only the active theme's logo downloads. Regenerate by trimming and scaling only. |
| `paiso-logo-256.png` | The original artwork at 256px. No longer rendered by `PaisoMark`; kept as a scaled copy of the source. |
| `paiso-logo.png` | **The logo, and the only source of truth.** Supplied as raster artwork; the white backing and drop shadow it shipped with have been cut away, so the rounded corners are transparent. Every icon under `public/` is this file scaled. |
| `paiso-icon*.svg` | **Legacy.** The hand-drawn tile that predates the logo. Not used to build anything any more; kept only so older references resolve. Do not redraw a logo as SVG; use the supplied files. |

## The edge around the mark

`.paiso-mark` in `src/index.css` draws a faint edge that follows the tile's
rounded corners, in the surrounding text colour. It is what keeps a tile
visible on a surface of its own colour (Swiss on white, Editorial on cream,
Verdant Grove on its dark sidebar). The artwork itself is not changed.

## Regenerating the icons

Scaling is the only transform. `icon-512.png`, `icon-192.png` and
`favicon.png` are the logo resized, corners still transparent.
`icon-512-maskable.png` and `apple-touch-icon.png` have to be opaque, so their
corner gaps are filled with the tile's own colour sampled from the logo at that
row — continuous with the art rather than a second surface behind it.

A maskable icon is only guaranteed its central 80% circle, and the wordmark is
wider than that, so a launcher that crops to a circle may clip the "p" and the
"o". That is accepted deliberately: the artwork is used as delivered, and most
launchers crop to a squircle.

## Brand colors

Sampled from `paiso-logo.png`:

- **Deep green tile:** `#1f4b2e` → `#062a1a` (gradient)
- **Bars:** `#4e8e2b` → `#7ac13c`
- **Leaf:** `#5a9c28` → `#8fd14a`
- **Primary (default `editorial` theme):** `hsl(93 55% 28%)` light,
  `hsl(93 50% 52%)` dark — the bar green darkened/lightened until text on it
  clears 4.5:1. See `src/index.css`.

import { getDisplayScale } from "@/store/displayMode";

/** Evenly-cadenced X-axis ticks for time series charts.
 *
 *  Recharts' `interval="preserveStartEnd"` decides which labels to keep by
 *  measuring overlap, then force-keeps the first and last. On a daily series
 *  that produces a ragged axis: an even run of one-day steps and then, where
 *  two labels would have collided, a jump to two- and three-day steps at the
 *  right-hand end (…9/17, 9/18, 9/19, 9/21, 9/23). Handing it an explicit tick
 *  list instead puts every label on a fixed stride.
 *
 *  The stride is in array positions, which is also what the chart draws with:
 *  these are category axes, so a point's x position is its index, not its date.
 *  Striding by index therefore keeps the labels evenly spaced on screen — and
 *  on a daily series, which is a continuous calendar once the non-trading days
 *  are filled in, evenly spaced on screen is evenly spaced in days too.
 *
 *  Ticks are laid out from the last point backwards, so the newest value — the
 *  one the headline is quoting — is always labelled, and every gap is exactly
 *  `stride` wide. The first point may go unlabelled; a uniform axis is worth
 *  more than a label on the left edge.
 */
export function evenTicks<T>(
  data: readonly T[],
  key: keyof T,
  maxTicks: number,
): string[] | undefined {
  const n = data.length;
  if (n === 0 || maxTicks < 2) return undefined;
  if (n <= maxTicks) return data.map((d) => String(d[key]));

  const stride = Math.ceil((n - 1) / (maxTicks - 1));
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= stride) out.push(String(data[i][key]));
  return out.reverse();
}

/** How many date labels fit an axis at the current breakpoint. Dates render as
 *  "Sep 23" or "Sep ’26" (~35px, see formatAxisDate); these counts leave room
 *  around them at 375px and at a full-width desktop card. */
export function dateTickCount(isMobile: boolean): number {
  return isMobile ? 4 : 8;
}

/** Round, evenly spaced ticks for a value axis.
 *
 *  Recharts' own "auto" domain, and the padded domain functions some charts
 *  used, put ticks at whatever values the padding produced (27.2K, 27.6K,
 *  28.3K…), and a flat series spread a few cents over the whole axis, so every
 *  tick printed the same "−5K". This picks a step of 1, 2, 2.5 or 5 times a
 *  power of ten and widens a flat series to a visible band.
 *
 *  `fromZero` keeps $0 on the axis, for series read from it (stacked bands). */
export function niceScale(
  values: readonly (number | null | undefined)[],
  { target = 4, fromZero = false }: { target?: number; fromZero?: boolean } = {},
): { domain: [number, number]; ticks: number[]; step: number } | undefined {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return undefined;
  let lo = Math.min(...finite);
  let hi = Math.max(...finite);
  if (fromZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  if (hi - lo < 1e-9) {
    const pad = Math.max(Math.abs(hi) * 0.05, 1);
    if (!(fromZero && lo === 0)) lo -= pad;
    hi += pad;
  }
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { domain: [start, end], ticks, step };
}

/** niceScale for money, with its tick formatter. */
export function niceMoneyAxis(
  values: readonly (number | null | undefined)[],
  options?: { target?: number; fromZero?: boolean },
): { domain: [number, number]; ticks: number[]; tickFormatter: (v: number) => string } | undefined {
  const scale = niceScale(values, options);
  return scale && { domain: scale.domain, ticks: scale.ticks, tickFormatter: (v: number) => formatAxisMoney(v) };
}

/** "27.5K", "−5K": compact, with only the digits the value needs. Ticks
 *  are multiples of a round step, so neighbouring ones always differ. */
export function formatAxisMoney(value: number, scale = getDisplayScale()): string {
  const v = value * scale;
  const abs = Math.abs(v);
  const [unit, suffix] = abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const n = abs / unit;
  const digits = [0, 1, 2].find((d) => Math.abs(Math.round(n * 10 ** d) - n * 10 ** d) < 1e-6) ?? 2;
  return `${v < 0 ? "−" : ""}${n.toFixed(digits)}${suffix}`;
}

/** niceMoneyAxis from a chart's rows: the values under `keys`, spread onto
 *  an XAxis or YAxis. Bar charts pass `fromZero` so bars rise from $0. */
export function moneyAxisFor(
  rows: readonly object[] | undefined,
  keys: readonly string[],
  options?: { target?: number; fromZero?: boolean },
): { domain?: [number, number]; ticks?: number[]; tickFormatter: (v: number) => string } {
  const values = (rows ?? []).flatMap((r) => keys.map((k) => (r as Record<string, unknown>)[k] as number));
  return niceMoneyAxis(values, options) ?? { tickFormatter: (v: number) => formatAxisMoney(v) };
}

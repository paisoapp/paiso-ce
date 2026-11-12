// Temporary comparison: should the chart view toggles (Trend,
// Bars, Sankey) show words or icons? `?chart-toggle=icons` or
// `?chart-toggle=text` on any page sets it for this browser. Remove once the
// owner picks one.
const KEY = "paiso-chart-toggle";

type ChartToggleStyle = "text" | "icons";

function read(): ChartToggleStyle {
  try {
    const asked = new URLSearchParams(window.location.search).get("chart-toggle");
    if (asked === "icons" || asked === "text") localStorage.setItem(KEY, asked);
    return localStorage.getItem(KEY) === "icons" ? "icons" : "text";
  } catch {
    return "text";
  }
}

export function chartToggleStyle(): ChartToggleStyle {
  return read();
}

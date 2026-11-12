// Chart catalogue guard: every chart can be put on the dashboard.
//
// A file that draws a chart (imports recharts) passes when either
//   • a widget in src/pages/Dashboard/widgets/registry.tsx names it in its
//     `sources`, so "Add widget" offers that chart; or
//   • it says why it is not offered, in a comment of the form
//     `dashboard-catalog: not offered, <reason>` (a chart of one account, one
//     property or one plan, for example).
// The dashboard's own widget files are the catalogue itself and are skipped.
// A new chart therefore fails the build until someone decides which it is.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;
const REGISTRY = join(SRC, "pages/Dashboard/widgets/registry.tsx");
const DASHBOARD_DIR = "pages/Dashboard/";
const MARKER = /dashboard-catalog:\s*not offered,\s*\S/;

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) yield path;
  }
}

const registry = await readFile(REGISTRY, "utf8");
const named = new Set();
for (const m of registry.matchAll(/sources:\s*\[([^\]]*)\]/g)) {
  for (const s of m[1].matchAll(/"([^"]+)"/g)) named.add(s[1]);
}

const problems = [];
let charts = 0;
for await (const path of sourceFiles(SRC)) {
  const rel = relative(SRC, path);
  if (rel.startsWith(DASHBOARD_DIR)) continue;
  const text = await readFile(path, "utf8");
  if (!/from\s+["']recharts["']/.test(text)) continue;
  charts++;
  if (named.has(rel) || MARKER.test(text)) continue;
  problems.push(rel);
}
for (const rel of named) {
  try { await readFile(join(SRC, rel)); } catch { problems.push(`${rel} (named in registry.tsx, but no such file)`); }
}

if (problems.length) {
  console.error("check-charts: these charts are not in the dashboard catalogue:");
  for (const p of problems) console.error(`  src/${p}`);
  console.error(
    "Add a widget for the chart to src/pages/Dashboard/widgets/registry.tsx and name the file in its `sources`,\n" +
    "or add a comment `dashboard-catalog: not offered, <reason>` to the file.",
  );
  process.exit(1);
}
console.log(`check-charts: ${charts} chart file(s) catalogued`);

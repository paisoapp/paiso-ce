// Copy guard for the Paiso writing style: no em-dashes, no contractions.
//
// The marketing site's check (marketing/scripts/check-copy.mjs) reads built
// HTML. The app has no HTML to read: its copy lives in the source, as JSX text
// and string literals. So this one parses each file and looks only at those,
// which means a code comment never trips it. Every file under src is checked.
//
// Active voice and plain wording cannot be checked by a pattern. They stay a
// review step.
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

const SRC = new URL("../src/", import.meta.url).pathname;

// An apostrophe-s is a contraction only after these words; anywhere else it is
// a possessive ("Paiso's", "your partner's").
const S_WORDS = "it|that|there|here|what|who|where|when|how|let|he|she";
const RULES = [
  { name: "em-dash", re: /—/g },
  { name: "contraction", re: /\b[a-z]+(?:n['’]t|['’](?:re|ve|ll|m|d))\b/gi },
  { name: "contraction", re: new RegExp(`\\b(?:${S_WORDS})['\\u2019]s\\b`, "gi") },
];

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|d)\.tsx?$/.test(entry.name)) yield path;
  }
}

/** Every piece of text in the file that could reach the screen. */
function copyOf(source) {
  const out = [];
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      // JSX text keeps its entities, so "isn&apos;t" slipped past the rules.
      out.push({ text: node.text.replace(/&apos;|&#39;|&rsquo;/g, "'"), line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

let failures = 0;
let files = 0;
for await (const file of sourceFiles(SRC)) {
  const page = relative(SRC, file);
  files++;
  const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  for (const { text, line } of copyOf(source)) {
    // A dash on its own is the app's mark for "no value" in a table cell or
    // a stat, not punctuation in a sentence.
    // A placeholder stands alone, as the whole string or on a line of its
    // own. "— " running into an expression is punctuation and still counts.
    if (text.trim() === "—" && (text === "—" || text.includes("\n"))) continue;
    for (const { name, re } of RULES) {
      for (const m of text.matchAll(re)) {
        const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
        console.error(`${page}:${line}: ${name} "${m[0]}" in "...${around}..."`);
        failures++;
      }
    }
  }
}

if (failures) {
  console.error(`\ncheck-copy: ${failures} problem(s). Paiso copy uses no em-dashes and no contractions.`);
  process.exit(1);
}
console.log(`check-copy: ${files} file(s) clean`);

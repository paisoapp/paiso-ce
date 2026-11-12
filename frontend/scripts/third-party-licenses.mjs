#!/usr/bin/env node
/**
 * Writes dist/third-party-licenses.txt: every npm package the built web app
 * ships (the non-dev entries in package-lock.json), with its licence and the
 * text of its licence file. Settings > About links to it. The Docker build
 * appends the Python packages (backend/scripts/python_licenses.py).
 *
 * Runs after `vite build`, which empties dist/.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;
const RULE = "=".repeat(78);

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const seen = new Map();
for (const [path, meta] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || meta.dev || meta.devOptional) continue;
  const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
  const key = `${name}@${meta.version}`;
  if (!seen.has(key)) seen.set(key, { name, version: meta.version, license: meta.license, path });
}

const sections = [...seen.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  .map(({ name, version, license, path }) => {
    const files = existsSync(path) ? readdirSync(path).filter((f) => LICENSE_FILE.test(f)) : [];
    const texts = files.map((f) => readFileSync(join(path, f), "utf8").trim());
    return [`${name} ${version}`, `License: ${license ?? "not stated"}`, "", ...texts].join("\n");
  });

const header = [
  "Third-party software in Paiso",
  "",
  "Paiso is licensed under the GNU Affero General Public License version 3.",
  "It includes the open-source packages below, each under its own license.",
  "",
  "Web app (npm)",
].join("\n");

writeFileSync("dist/third-party-licenses.txt", [header, ...sections].join(`\n\n${RULE}\n\n`) + "\n");
console.log(`third-party-licenses: ${sections.length} npm packages`);

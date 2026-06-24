#!/usr/bin/env node
// @ts-check
/**
 * Regression-guard for cubby conventions. Runs in `pnpm check` alongside
 * biome + typecheck. No dependencies; uses git ls-files (falls back to a
 * recursive walk) so it only scans tracked source.
 *
 * Checks:
 *  1. Hardcoded chromatic Tailwind colors in apps/web/src tsx — protects the
 *     Phase 1 color sweep (use design tokens, never `text-red-500` etc.).
 *  2. Reintroduction of a TS `calculateTotals` costing engine — costing must
 *     stay in the Rust/WASM crate (recipebridge), never reimplemented in TS.
 *
 * Exit 1 + a report on any violation; exit 0 + one-line OK when clean.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webSrc = join(repoRoot, "apps", "web", "src");

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/** @returns {string[]} absolute paths */
function gitTrackedTsx() {
  const out = execFileSync(
    "git",
    ["ls-files", "apps/web/src/**/*.tsx", "apps/web/src/**/*.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .map((p) => join(repoRoot, p));
}

/** Recursive fallback if git is unavailable. @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const found = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) found.push(...walk(full));
    else if (full.endsWith(".tsx") || full.endsWith(".ts")) found.push(full);
  }
  return found;
}

function listFiles() {
  try {
    const files = gitTrackedTsx();
    if (files.length > 0) return files;
  } catch {
    // fall through to walk
  }
  try {
    return walk(webSrc);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

// Files allowed to use raw chromatic colors (design surfaces / illustrations).
const COLOR_EXCLUDE_BASENAMES = new Set([
  "design-gallery.tsx",
  "design.tsx",
  "IsometricPantry.tsx",
]);

const COLOR_RE =
  /\b(text|bg|border|ring|from|to|via|fill|stroke|decoration|outline)-(red|green|amber|yellow|emerald|rose|orange|lime|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink)-[0-9]{2,3}\b/;

// The old deleted TS costing engine. Test fixtures/helpers legitimately wrap
// the WASM engine under this name, so exempt test + fixture files.
const CALC_TOTALS_RE = /\bfunction\s+calculateTotals\b|\bcalculateTotals\s*=/;

function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function basename(path) {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function isTestOrFixture(path) {
  const b = basename(path);
  return (
    b.includes(".test.") ||
    b.includes(".spec.") ||
    b.includes(".fixtures.") ||
    b.includes(".fixture.")
  );
}

/** @typedef {{ file: string, line: number, snippet: string, rule: string }} Violation */

/** @param {string[]} files @returns {Violation[]} */
function scan(files) {
  /** @type {Violation[]} */
  const violations = [];

  for (const file of files) {
    const isTsx = file.endsWith(".tsx");
    const base = basename(file);
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";

      // Rule 1: hardcoded chromatic Tailwind colors (tsx only, non-comment).
      if (
        isTsx &&
        !COLOR_EXCLUDE_BASENAMES.has(base) &&
        !isCommentLine(line) &&
        COLOR_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "hardcoded-color",
        });
      }

      // Rule 2: reintroduced TS calculateTotals engine (any non-test source).
      if (
        !isTestOrFixture(file) &&
        !isCommentLine(line) &&
        CALC_TOTALS_RE.test(line)
      ) {
        violations.push({
          file,
          line: i + 1,
          snippet: line.trim(),
          rule: "ts-calculateTotals",
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const files = listFiles();
const violations = scan(files);

if (violations.length === 0) {
  console.log(
    `OK: check-conventions passed (${files.length} files scanned, 0 violations).`,
  );
  process.exit(0);
}

const byRule = {
  "hardcoded-color":
    "Hardcoded chromatic Tailwind colors — use design tokens in apps/web/src/styles.css (see CLAUDE.md Colors).",
  "ts-calculateTotals":
    "TS `calculateTotals` costing reimplementation — costing must stay in the WASM crate (recipebridge), not TS.",
};

console.error(
  `check-conventions: ${violations.length} violation(s) found.\n`,
);

for (const rule of Object.keys(byRule)) {
  const hits = violations.filter((v) => v.rule === rule);
  if (hits.length === 0) continue;
  console.error(`▸ ${byRule[rule]}`);
  for (const v of hits) {
    console.error(`    ${relative(repoRoot, v.file)}:${v.line}: ${v.snippet}`);
  }
  console.error("");
}

process.exit(1);

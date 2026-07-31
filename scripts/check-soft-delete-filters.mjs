#!/usr/bin/env node
/**
 * Guard: an EXISTS / NOT EXISTS subquery over a soft-deletable table must
 * filter soft-deleted rows.
 *
 * Why this rule exists: we shipped the same bug three times in one file. A
 * subquery like
 *
 *   notExists(db.select().from(inventoryEntry).where(eq(inventoryEntry.productId, product.id)))
 *
 * reads as "this product has no inventory", but a soft-deleted row still
 * satisfies EXISTS — so the product silently fails the check. Emptying a shelf
 * soft-deletes rather than removes, so the deleted case is the COMMON path, not
 * the edge one: `findOrphanedProducts` was missing 18 of 20 real hits (#428).
 *
 * Scope is deliberately narrow — only `exists()` / `notExists()` arguments, not
 * every query. That is where all three bugs lived, and a subquery over a
 * soft-deletable table essentially always means "live rows only", so the false
 * positive rate is ~0. Ordinary top-level queries are left to review.
 *
 * Opt out for the rare subquery that genuinely wants deleted rows (cleanup and
 * orphan-detection paths) with a comment on or above the call:
 *
 *   // includes-deleted: orphan sweep must see rows whose entity is gone
 *
 * Run standalone: node scripts/check-soft-delete-filters.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(repoRoot, "apps/web/src/server/db/schema.ts");
const OPT_OUT = "includes-deleted";

/** Table consts declared with `...softDeletedAt()` in their pgTable body. */
function softDeletableTables() {
  const source = readFileSync(schemaPath, "utf8");
  const decl = /export const (\w+) = pgTable\(/g;
  const names = new Set();
  let match;
  while ((match = decl.exec(source))) {
    const next = source.indexOf("export const", match.index + 10);
    const body = source.slice(match.index, next < 0 ? source.length : next);
    if (body.includes("softDeletedAt()")) names.add(match[1]);
  }
  return names;
}

function serverSources() {
  const out = execFileSync(
    "git",
    ["ls-files", "apps/web/src/server/**/*.ts", "packages/*/src/**/*.ts"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(
      (p) =>
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        existsSync(join(repoRoot, p)),
    );
}

/**
 * From the "(" at `open`, return [start,end) of the balanced argument text.
 * String and comment contents are skipped so a paren inside them can't
 * unbalance the scan.
 */
function balancedSlice(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = text.indexOf("\n", i);
      if (i < 0) return null;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i);
      if (i < 0) return null;
      i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return [open + 1, i];
    }
  }
  return null;
}

const tables = softDeletableTables();
const tablePattern = new RegExp(
  `\\.(?:from|\\w*[Jj]oin)\\(\\s*(${[...tables].join("|")})\\b`,
);
const callPattern = /\b(exists|notExists)\s*\(/g;
const violations = [];

for (const file of serverSources()) {
  const abs = join(repoRoot, file);
  const text = readFileSync(abs, "utf8");
  if (!text.includes("xists(")) continue;

  callPattern.lastIndex = 0;
  let call;
  while ((call = callPattern.exec(text))) {
    const open = call.index + call[0].length - 1;
    const span = balancedSlice(text, open);
    if (!span) continue;
    const body = text.slice(span[0], span[1]);

    const queried = body.match(tablePattern);
    if (!queried) continue;

    // Opt-out marker anywhere in the 200 chars preceding the call.
    const preamble = text.slice(Math.max(0, call.index - 200), call.index);
    if (preamble.includes(OPT_OUT)) continue;

    // notDeleted(table) is the helper; isNull(x.deletedAt) is the longhand.
    if (body.includes("notDeleted") || body.includes("deletedAt")) continue;

    violations.push({
      file: relative(repoRoot, abs),
      line: text.slice(0, call.index).split("\n").length,
      table: queried[1],
      kind: call[1],
    });
  }
}

if (violations.length > 0) {
  console.error(
    `\nFAIL: ${violations.length} EXISTS subquery(s) over a soft-deletable table with no soft-delete filter.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.kind}(… .from(${v.table}) …)`);
  }
  console.error(
    `\nAdd notDeleted(<table>) inside the subquery's where().` +
      `\nIf the subquery genuinely must see deleted rows, mark it with a` +
      ` "${OPT_OUT}: <reason>" comment.\n`,
  );
  process.exit(1);
}

console.log(
  `OK: check-soft-delete-filters passed (${tables.size} soft-deletable tables).`,
);

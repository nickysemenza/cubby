#!/usr/bin/env node
/**
 * EXISTS subqueries over soft-deletable tables must filter deleted rows.
 * `// includes-deleted: <reason>` is the audited opt-out. Both Drizzle calls
 * and raw/template SQL forms are scanned; parser constraints stay by helpers.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = join(repoRoot, "apps/web/src/server/db/schema.ts");
const OPT_OUT = "includes-deleted";

/**
 * Soft-deletable tables declared with `...softDeletedAt()` in their pgTable
 * body, keyed both ways: `varNames` is the drizzle export (e.g. `expense`,
 * used by `.from(x)`/`.join(x)` and by `${x}` raw-SQL interpolation), and
 * `sqlNameToVar`/`varToSqlName` map the quoted SQL identifier (e.g.
 * `"Expense"`, used by raw SQL text) to and from that export name.
 */
function softDeletableTables() {
  const source = readFileSync(schemaPath, "utf8");
  const decl = /export const (\w+) = pgTable\(\s*"(\w+)"/g;
  const varNames = new Set();
  const sqlNameToVar = new Map();
  const varToSqlName = new Map();
  let match;
  while ((match = decl.exec(source))) {
    const [, varName, sqlName] = match;
    const next = source.indexOf("export const", match.index + 10);
    const body = source.slice(match.index, next < 0 ? source.length : next);
    if (body.includes("softDeletedAt()")) {
      varNames.add(varName);
      sqlNameToVar.set(sqlName, varName);
      varToSqlName.set(varName, sqlName);
    }
  }
  return { varNames, sqlNameToVar, varToSqlName };
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
 * Advance past an opaque token starting at `text[i]`: a quoted string, a
 * line/block comment, or a full template literal — including any nested
 * `${...}` interpolation, which may itself contain strings, comments, or
 * further nested template literals. Returns the index just past the token,
 * or -1 if it never closes.
 *
 * Shared by the paren-balancer (so a `${sql\`...\`}` inside an EXISTS(...)
 * argument doesn't unbalance its parens) and the template-range finder (so a
 * nested `${sql\`...\`}` doesn't prematurely close the outer template).
 */
function isOpaqueStart(text: string, i: number): boolean {
  const ch = text[i];
  return (
    ch === '"' ||
    ch === "'" ||
    ch === "`" ||
    (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
  );
}

function skipQuoted(text: string, i: number): number {
  const quote = text[i];
  i++;
  while (i < text.length && text[i] !== quote) i += text[i] === "\\" ? 2 : 1;
  return i < text.length ? i + 1 : -1;
}

function skipComment(text: string, i: number): number | undefined {
  if (text[i] !== "/") return undefined;
  if (text[i + 1] === "/") {
    const newline = text.indexOf("\n", i);
    return newline < 0 ? text.length : newline + 1;
  }
  if (text[i + 1] !== "*") return undefined;
  const close = text.indexOf("*/", i + 2);
  return close < 0 ? -1 : close + 2;
}

function skipTemplateInterpolation(text: string, i: number): number {
  let depth = 1;
  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (isOpaqueStart(text, i)) {
      const next = skipOpaque(text, i);
      if (next < 0) return -1;
      i = next;
      continue;
    }
    i++;
  }
  return depth === 0 ? i : -1;
}

function skipTemplate(text: string, i: number): number {
  for (i++; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] !== "$" || text[i + 1] !== "{") continue;
    i = skipTemplateInterpolation(text, i + 2);
    if (i < 0) return -1;
    i--;
  }
  return -1;
}

function skipOpaque(text: string, i: number): number {
  if (text[i] === "`") return skipTemplate(text, i);
  const comment = skipComment(text, i);
  if (comment !== undefined) return comment;
  return text[i] === '"' || text[i] === "'" ? skipQuoted(text, i) : i + 1;
}

/**
 * From the "(" at `open`, return [start,end) of the balanced argument text.
 * String, comment, and template-literal contents are skipped (via
 * `skipOpaque`) so a paren inside them can't unbalance the scan.
 */
function balancedSlice(text: string, open: number) {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (
      ch === '"' ||
      ch === "'" ||
      ch === "`" ||
      (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
    ) {
      const next = skipOpaque(text, i);
      if (next < 0) return null;
      i = next;
      continue;
    }
    if (ch === "(") {
      depth++;
      i++;
      continue;
    }
    if (ch === ")") {
      depth--;
      i++;
      if (depth === 0) return [open + 1, i - 1];
      continue;
    }
    i++;
  }
  return null;
}

/**
 * [start,end) ranges of every backtick template literal's contents in the
 * file — tagged (`sql\`...\``, `sql<T>\`...\``) or not (a plain string later
 * handed to `sql.raw(...)`, possibly assembled from several concatenated
 * literals). A single left-to-right walk, so a nested `${sql\`...\`}` is
 * consumed as part of its enclosing literal via `skipOpaque` and never
 * revisited as a separate top-level range — ranges never overlap. Quoted
 * strings and comments are skipped outright so a backtick inside either
 * (e.g. a markdown code span in a docblock) is never mistaken for the start
 * of a template.
 */
function allTemplateRanges(text: string) {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (
      ch === '"' ||
      ch === "'" ||
      (ch === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
    ) {
      const next = skipOpaque(text, i);
      if (next < 0) break;
      i = next;
      continue;
    }
    if (ch === "`") {
      const start = i + 1;
      const closeAfter = skipOpaque(text, i);
      if (closeAfter < 0) break;
      ranges.push([start, closeAfter - 1]);
      i = closeAfter;
      continue;
    }
    i++;
  }
  return ranges;
}

/**
 * SQL keywords that can legitimately follow `FROM "Table"` / `JOIN "Table"`
 * with NO alias in between (`FROM "Table"\n WHERE ...`, `JOIN "Table" ON
 * ...`). Without this denylist the optional-alias capture in the table-ref
 * regexes below greedily swallows the keyword as if it were an alias — e.g.
 * `FROM "InventoryEntry"\n WHERE "InventoryEntry"."deletedAt" IS NULL` reads
 * as alias `WHERE`, so the guard search for `WHERE."deletedAt"` (which never
 * appears) fails even though the query is correctly guarded via the table's
 * own quoted name. Filtered case-insensitively; see the (unaliased) fallback
 * a few lines down for what happens once a would-be alias is rejected here.
 */
const SQL_KEYWORDS = new Set([
  "WHERE",
  "AS",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "ON",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "WINDOW",
  "RETURNING",
  "AND",
  "OR",
  "NOT",
  "EXISTS",
  "SELECT",
  "FROM",
  "INTO",
  "VALUES",
  "SET",
  "USING",
  "NATURAL",
  "LATERAL",
  "WITH",
]);

/** Reject a captured alias that's actually the next SQL keyword, not a name. */
const cleanAlias = (rawAlias: string | undefined) =>
  rawAlias && !SQL_KEYWORDS.has(rawAlias.toUpperCase()) ? rawAlias : undefined;

const { varNames, sqlNameToVar, varToSqlName } = softDeletableTables();
const tablePattern = new RegExp(
  `\\.(?:from|\\w*[Jj]oin)\\(\\s*(${[...varNames].join("|")})\\b`,
);
const callPattern = /\b(exists|notExists)\s*\(/g;
const tableRefQuoted = /\b(?:FROM|JOIN)\s+"(\w+)"(?:\s+(?:AS\s+)?(\w+))?/g;
const tableRefInterp = /\b(?:FROM|JOIN)\s+\$\{(\w+)\}(?:\s+(?:AS\s+)?(\w+))?/g;
type Violation = { file: string; line: number; detail: string };
const violations: Violation[] = [];

for (const file of serverSources()) {
  const abs = join(repoRoot, file);
  const text = readFileSync(abs, "utf8");
  const lineOf = (index: number) => text.slice(0, index).split("\n").length;
  const hasOptOut = (callIndex: number) =>
    text.slice(Math.max(0, callIndex - 200), callIndex).includes(OPT_OUT);

  if (text.includes("xists(")) {
    callPattern.lastIndex = 0;
    let call;
    while ((call = callPattern.exec(text))) {
      const open = call.index + call[0].length - 1;
      const span = balancedSlice(text, open);
      if (!span) continue;
      const body = text.slice(span[0], span[1]);

      const queried = body.match(tablePattern);
      if (!queried) continue;

      if (hasOptOut(call.index)) continue;

      if (body.includes("notDeleted") || body.includes("deletedAt")) continue;

      violations.push({
        file: relative(repoRoot, abs),
        line: lineOf(call.index),
        detail: `${call[1]}(… .from(${queried[1]}) …)`,
      });
    }
  }

  if (text.includes("EXISTS")) {
    const seen = new Set<string>(); // dedupe safety net; occurrences are non-overlapping by construction
    const existsPattern = /\b(NOT\s+)?EXISTS\s*\(/g;
    for (const [rangeStart, rangeEnd] of allTemplateRanges(text)) {
      const literal = text.slice(rangeStart, rangeEnd);

      // Find every EXISTS/NOT EXISTS in this literal — not just the first —
      // and resolve each independently. Two sibling subqueries commonly
      // reuse the same alias (`EXISTS (... ie ...) OR EXISTS (... ie
      // ...)`), so a guard belonging to one must never satisfy the other.
      existsPattern.lastIndex = 0;
      const occurrences = [...literal.matchAll(existsPattern)];

      for (const [idx, occ] of occurrences.entries()) {
        const existsIndex = rangeStart + occ.index;
        if (hasOptOut(existsIndex)) continue;
        const kind = occ[1] ? "NOT EXISTS" : "EXISTS";

        // Prefer the balanced-paren argument. A genuine balance is trustworthy
        // on its own (it's the same paren-matching that correctly handles a
        // NESTED EXISTS inside this one's WHERE clause, whose own close comes
        // before the outer's) — no extra bound needed once it succeeds.
        //
        // Only fall back — to "this occurrence up to the START of the NEXT
        // occurrence in this literal, or the literal's end for the last one" —
        // when the parens never close within this literal at all: several
        // raw-SQL sites (data-quality.ts's purchaseGapRaw/
        // purchaseProductGapRaw/activeExceptionRaw) assemble one EXISTS(...)
        // by concatenating several SEPARATE template literals at runtime
        // (`` `${base} ${condition} AND ${exceptionAbsent})` ``), so the "("
        // this literal opens is closed in a DIFFERENT literal — no balanced
        // scan of this literal alone can ever find it. The next-occurrence
        // bound keeps that fallback from reading into a sibling subquery's
        // own (properly closed) guard. Do not collapse this to one strategy
        // for the whole literal: that either loses the reach those sites
        // need (tagged-only / balanced-only) or loses precision for every
        // self-contained EXISTS (whole-literal / first-occurrence-only,
        // which lets one occurrence's guard satisfy a sibling's — see #637
        // review history).
        const localOpen = occ.index + occ[0].length - 1;
        const span = balancedSlice(literal, localOpen);
        const nextStart = occurrences[idx + 1]?.index ?? literal.length;
        const body = span
          ? literal.slice(span[0], span[1])
          : literal.slice(occ.index, nextStart);

        const refs: Array<{
          table: string;
          alias: string;
          aliasIsBare: boolean;
        }> = [];
        tableRefQuoted.lastIndex = 0;
        let ref;
        while ((ref = tableRefQuoted.exec(body))) {
          const [, sqlName, rawAlias] = ref;
          if (!sqlName || !sqlNameToVar.has(sqlName)) continue;
          const alias = cleanAlias(rawAlias);
          refs.push({
            table: sqlName,
            alias: alias ?? sqlName,
            aliasIsBare: Boolean(alias),
          });
        }
        tableRefInterp.lastIndex = 0;
        while ((ref = tableRefInterp.exec(body))) {
          const [, varName, rawAlias] = ref;
          if (!varName || !varNames.has(varName)) continue;
          const alias = cleanAlias(rawAlias);
          const sqlName = varToSqlName.get(varName);
          if (!sqlName) continue;
          refs.push({
            table: sqlName,
            alias: alias ?? sqlName,
            aliasIsBare: Boolean(alias),
          });
        }

        for (const { table, alias, aliasIsBare } of refs) {
          const guard = aliasIsBare
            ? new RegExp(`\\b${alias}\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`)
            : new RegExp(`"${alias}"\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`);
          if (guard.test(body)) continue;

          const line = lineOf(existsIndex);
          const key = `${abs}:${existsIndex}:${table}:${alias}`;
          if (seen.has(key)) continue;
          seen.add(key);

          violations.push({
            file: relative(repoRoot, abs),
            line,
            detail: `raw sql ${kind}(… FROM/JOIN "${table}" ${aliasIsBare ? alias : "(unaliased)"} … — missing ${aliasIsBare ? alias : `"${table}"`}."deletedAt" IS NULL)`,
          });
        }
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `\nFAIL: ${violations.length} EXISTS subquery(s) over a soft-deletable table with no soft-delete filter.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.detail}`);
  }
  console.error(
    `\nAdd notDeleted(<table>) inside the subquery's where() (drizzle form) or an` +
      ` alias."deletedAt" IS NULL predicate (raw sql form).` +
      `\nIf the subquery genuinely must see deleted rows, mark it with a` +
      ` "${OPT_OUT}: <reason>" comment.\n`,
  );
  process.exit(1);
}

console.log(
  `OK: check-soft-delete-filters passed (${varNames.size} soft-deletable tables).`,
);

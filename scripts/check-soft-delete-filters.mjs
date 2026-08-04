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
 * Scope is deliberately narrow — only `exists()` / `notExists()` arguments (and,
 * below, raw `sql\`...\`` EXISTS text), not every query. That is where all
 * three original bugs lived, and a subquery over a soft-deletable table
 * essentially always means "live rows only", so the false positive rate is ~0.
 * Ordinary top-level queries are left to review.
 *
 * Opt out for the rare subquery that genuinely wants deleted rows (cleanup and
 * orphan-detection paths) with a comment on or above the call:
 *
 *   // includes-deleted: orphan sweep must see rows whose entity is gone
 *
 * ---
 *
 * Second form: raw template-literal SQL text. Drizzle's exists()/notExists()
 * are JS-level function calls, easy to find with a balanced-paren scan of their
 * argument. But several repos build correlated EXISTS subqueries as raw SQL
 * text instead — `sql\`EXISTS (SELECT 1 FROM "Expense" e WHERE ... )\`` — because
 * the query needs a JOIN, an aggregate, or a jsonb operator drizzle's builder
 * can't express. Those are invisible to the scan above: there is no `.from(x)`
 * or `.join(x)` call to match, just a quoted SQL identifier or a `${tableVar}`
 * interpolation sitting inside a template string. A soft-deleted row still
 * satisfies raw-SQL EXISTS for exactly the same reason it satisfies drizzle's
 * — this is the same bug class, just a different surface.
 *
 * Some of these aren't even tagged `sql\`...\`` — data-quality.ts's
 * purchaseGapRaw/purchaseProductGapRaw build EXISTS text as a PLAIN backtick
 * string, concatenated across several template literals (`` `${base}
 * ${condition} AND ${exceptionAbsent})` ``) and handed to `sql.raw(...)` only
 * at the call site, several lines and a ternary away. That concatenation means
 * the "EXISTS (" and its matching ")" frequently live in DIFFERENT template
 * literals — the open paren has no balanced close within the literal that
 * contains it. A balanced-paren scan of that literal alone can't find it (and
 * chasing the concatenation across expressions is effectively evaluating the
 * program, not parsing it — the "real SQL parser" territory this check is
 * supposed to stay out of). So this scan does not require the parens to
 * balance within one literal:
 *
 *   1. Find every backtick template literal in the file — tagged or not —
 *      with a template-literal-aware scanner so a nested `${sql\`...\`}`
 *      interpolation doesn't prematurely close an outer one, and so a
 *      backtick inside a block or line comment (e.g. a markdown code span in
 *      a docblock) is never mistaken for a template start.
 *   2. Within each literal, find the FIRST `EXISTS (` / `NOT EXISTS (` and
 *      take everything from there to the end of that literal as the body —
 *      not the balanced-paren argument. That covers a self-contained EXISTS
 *      (the common case) and also the concatenated-`base`-string case, since
 *      whatever guards the table stays in the SAME source literal even when
 *      the closing paren doesn't. It deliberately does not reach into a
 *      later, separately-concatenated literal (e.g. `${exceptionAbsent}`) —
 *      only what's textually present alongside the reference counts.
 *   3. Within that body, find every `FROM "Table" alias` / `JOIN "Table"
 *      alias` (quoted identifier) and `FROM ${tableVar} alias` / `JOIN
 *      ${tableVar} alias` (drizzle table interpolation) reference to a
 *      soft-deletable table, and require an `alias."deletedAt" IS NULL`
 *      predicate for THAT alias somewhere in the body (or the table's own
 *      quoted name, for the rare unaliased reference). A following SQL
 *      keyword (WHERE, ON, JOIN, …) is never mistaken for an alias — see
 *      `SQL_KEYWORDS` — so `FROM "Table"\n WHERE "Table"."deletedAt" IS NULL`
 *      (no alias at all) is recognized as guarded rather than misread as
 *      `FROM "Table" WHERE` with alias `WHERE`.
 *
 * This intentionally does not resolve fully dynamic table references (e.g.
 * `FROM ${sql.raw(\`"${runtimeVar}"\`)}`) — that would need evaluating the
 * program, not just parsing it, and is the same blind spot the drizzle-form
 * scan already has for a dynamic `.from(someVar)`. A subquery like that is
 * left to review, same as before.
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
function skipOpaque(text, i) {
  const ch = text[i];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    i++;
    while (i < text.length && text[i] !== quote) {
      i += text[i] === "\\" ? 2 : 1;
    }
    return i < text.length ? i + 1 : -1;
  }
  if (ch === "/" && text[i + 1] === "/") {
    const nl = text.indexOf("\n", i);
    return nl < 0 ? text.length : nl + 1;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i);
    return close < 0 ? -1 : close + 2;
  }
  if (ch === "`") {
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") return i + 1;
      if (c === "$" && text[i + 1] === "{") {
        i += 2;
        let depth = 1;
        while (i < text.length && depth > 0) {
          const cc = text[i];
          if (cc === "{") {
            depth++;
            i++;
          } else if (cc === "}") {
            depth--;
            i++;
          } else if (
            cc === '"' ||
            cc === "'" ||
            cc === "`" ||
            (cc === "/" && (text[i + 1] === "/" || text[i + 1] === "*"))
          ) {
            const nextI = skipOpaque(text, i);
            if (nextI < 0) return -1;
            i = nextI;
          } else {
            i++;
          }
        }
        continue;
      }
      i++;
    }
    return -1;
  }
  return i + 1;
}

/**
 * From the "(" at `open`, return [start,end) of the balanced argument text.
 * String, comment, and template-literal contents are skipped (via
 * `skipOpaque`) so a paren inside them can't unbalance the scan.
 */
function balancedSlice(text, open) {
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
function allTemplateRanges(text) {
  const ranges = [];
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
const cleanAlias = (rawAlias) =>
  rawAlias && !SQL_KEYWORDS.has(rawAlias.toUpperCase()) ? rawAlias : undefined;

const { varNames, sqlNameToVar, varToSqlName } = softDeletableTables();
const tablePattern = new RegExp(
  `\\.(?:from|\\w*[Jj]oin)\\(\\s*(${[...varNames].join("|")})\\b`,
);
const callPattern = /\b(exists|notExists)\s*\(/g;
const tableRefQuoted = /\b(?:FROM|JOIN)\s+"(\w+)"(?:\s+(?:AS\s+)?(\w+))?/g;
const tableRefInterp =
  /\b(?:FROM|JOIN)\s+\$\{(\w+)\}(?:\s+(?:AS\s+)?(\w+))?/g;
const violations = [];

for (const file of serverSources()) {
  const abs = join(repoRoot, file);
  const text = readFileSync(abs, "utf8");
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const hasOptOut = (callIndex) =>
    text.slice(Math.max(0, callIndex - 200), callIndex).includes(OPT_OUT);

  // --- drizzle exists()/notExists() form ---
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

      // notDeleted(table) is the helper; isNull(x.deletedAt) is the longhand.
      if (body.includes("notDeleted") || body.includes("deletedAt")) continue;

      violations.push({
        file: relative(repoRoot, abs),
        line: lineOf(call.index),
        detail: `${call[1]}(… .from(${queried[1]}) …)`,
      });
    }
  }

  // --- raw template-literal EXISTS form (tagged sql`` or plain) ---
  if (text.includes("EXISTS")) {
    const seen = new Set(); // dedupe: overlapping literals can revisit a table+alias
    for (const [rangeStart, rangeEnd] of allTemplateRanges(text)) {
      const literal = text.slice(rangeStart, rangeEnd);

      // Anchor on the FIRST EXISTS in this literal and scan from there to the
      // literal's end — not a balanced-paren argument. Several raw-SQL sites
      // (data-quality.ts's purchaseGapRaw/purchaseProductGapRaw) assemble one
      // EXISTS(...) by concatenating multiple template literals at runtime
      // (`` `${base} ${condition} AND ${exceptionAbsent})` ``), so the "(" this
      // literal opens is closed in a DIFFERENT literal — a balanced scan would
      // never find the guard. A table/alias's guard always stays textually
      // alongside its own reference within one literal even when the paren
      // doesn't close there, so this still can't wander into an unrelated,
      // earlier part of the same literal.
      const first = /\bEXISTS\s*\(/.exec(literal);
      if (!first) continue;
      const existsIndex = rangeStart + first.index;
      if (hasOptOut(existsIndex)) continue;
      const kind = /\bNOT\s+$/.test(
        text.slice(Math.max(0, existsIndex - 8), existsIndex),
      )
        ? "NOT EXISTS"
        : "EXISTS";
      const body = text.slice(existsIndex, rangeEnd);

      const refs = [];
      tableRefQuoted.lastIndex = 0;
      let ref;
      while ((ref = tableRefQuoted.exec(body))) {
        const [, sqlName, rawAlias] = ref;
        if (!sqlNameToVar.has(sqlName)) continue;
        const alias = cleanAlias(rawAlias);
        refs.push({ table: sqlName, alias: alias ?? sqlName, aliasIsBare: Boolean(alias) });
      }
      tableRefInterp.lastIndex = 0;
      while ((ref = tableRefInterp.exec(body))) {
        const [, varName, rawAlias] = ref;
        if (!varNames.has(varName)) continue;
        const alias = cleanAlias(rawAlias);
        const sqlName = varToSqlName.get(varName);
        refs.push({ table: sqlName, alias: alias ?? sqlName, aliasIsBare: Boolean(alias) });
      }

      for (const { table, alias, aliasIsBare } of refs) {
        const guard = aliasIsBare
          ? new RegExp(`\\b${alias}\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`)
          : new RegExp(`"${alias}"\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`);
        if (guard.test(body)) continue;

        const line = lineOf(existsIndex);
        const key = `${abs}:${line}:${table}:${alias}`;
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

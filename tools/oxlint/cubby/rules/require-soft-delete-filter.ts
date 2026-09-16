import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineRule } from "@oxlint/plugins";

import { softDeleteTableCatalog } from "../shared/schema-storage.ts";

/**
 * Port of the deleted `scripts/check-soft-delete-filters.ts` gate. Both the Drizzle
 * `exists`/`notExists` form and the raw/tagged `sql` form were pure text-regex scans
 * over a whole file in the original script (not AST walks), so this rule keeps that
 * exact text engine and runs it once per file over `context.sourceCode.text`,
 * reporting each match at its source offset. The soft-deletable table catalog is
 * parsed once, at plugin load, straight from `schema.ts` + the generated entity
 * columns file — the same parser the deleted `schema-storage.ts` used — so this never
 * trusts the `application-schema.json` snapshot's `lowerFirst(sqlName)` convention,
 * which does not hold for the `oauth_*` auth tables (correction 9).
 */

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const schemaPath = resolve(repoRoot, "apps/web/src/server/db/schema.ts");
const columnsPath = resolve(
  repoRoot,
  "apps/web/src/server/db/generated/entity-columns.gen.ts",
);
const OPT_OUT = "includes-deleted";

const { varNames, sqlNameToVar, varToSqlName } = softDeleteTableCatalog(
  readFileSync(schemaPath, "utf8"),
  [readFileSync(columnsPath, "utf8")],
);

const tablePattern = new RegExp(
  `\\.(?:from|\\w*[Jj]oin)\\(\\s*(${[...varNames].join("|")})\\b`,
);
const callPattern = /\b(exists|notExists)\s*\(/g;
const tableRefQuoted = /\b(?:FROM|JOIN)\s+"(\w+)"(?:\s+(?:AS\s+)?(\w+))?/g;
const tableRefInterp = /\b(?:FROM|JOIN)\s+\$\{(\w+)\}(?:\s+(?:AS\s+)?(\w+))?/g;

/**
 * SQL keywords that can legitimately follow `FROM "Table"` / `JOIN "Table"` with NO
 * alias in between. Without this denylist the optional-alias capture in the
 * table-ref regexes above greedily swallows the keyword as if it were an alias.
 * Filtered case-insensitively.
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
function cleanAlias(rawAlias: string | undefined): string | undefined {
  return rawAlias && !SQL_KEYWORDS.has(rawAlias.toUpperCase())
    ? rawAlias
    : undefined;
}

/**
 * Advance past an opaque token starting at `text[i]`: a quoted string, a line/block
 * comment, or a full template literal — including any nested `${...}`
 * interpolation. Returns the index just past the token, or -1 if it never closes.
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
  let index = i + 1;
  while (index < text.length && text[index] !== quote)
    index += text[index] === "\\" ? 2 : 1;
  return index < text.length ? index + 1 : -1;
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
  let index = i;
  while (index < text.length && depth > 0) {
    const ch = text[index];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (isOpaqueStart(text, index)) {
      const next = skipOpaque(text, index);
      if (next < 0) return -1;
      index = next;
      continue;
    }
    index++;
  }
  return depth === 0 ? index : -1;
}

function skipTemplate(text: string, i: number): number {
  let index = i + 1;
  for (; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === "`") return index + 1;
    if (text[index] !== "$" || text[index + 1] !== "{") continue;
    index = skipTemplateInterpolation(text, index + 2);
    if (index < 0) return -1;
    index--;
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
 * From the "(" at `open`, return [start,end) of the balanced argument text. String,
 * comment, and template-literal contents are skipped so a paren inside them can't
 * unbalance the scan.
 */
function balancedSlice(
  text: string,
  open: number,
): readonly [number, number] | null {
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
 * [start,end) ranges of every backtick template literal's contents in the file —
 * tagged or not (a plain string later handed to `sql.raw(...)`, possibly assembled
 * from several concatenated literals). Ranges never overlap.
 */
function allTemplateRanges(text: string): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
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

export type SoftDeleteViolation = Readonly<{ start: number; detail: string }>;

function scanDrizzleExistsCalls(text: string): SoftDeleteViolation[] {
  const violations: SoftDeleteViolation[] = [];
  if (!text.includes("xists(")) return violations;
  const hasOptOut = (callIndex: number) =>
    text.slice(Math.max(0, callIndex - 200), callIndex).includes(OPT_OUT);

  callPattern.lastIndex = 0;
  let call: RegExpExecArray | null;
  while ((call = callPattern.exec(text))) {
    const open = call.index + call[0].length - 1;
    const span = balancedSlice(text, open);
    if (!span) continue;
    const body = text.slice(span[0], span[1]);

    const queried = body.match(tablePattern);
    if (!queried?.[1]) continue;
    if (hasOptOut(call.index)) continue;
    if (body.includes("notDeleted") || body.includes("deletedAt")) continue;

    violations.push({
      start: call.index,
      detail: `${call[1]}(… .from(${queried[1]}) …) has no soft-delete filter`,
    });
  }
  return violations;
}

type TableRef = Readonly<{
  table: string;
  alias: string;
  aliasIsBare: boolean;
}>;

/** Every soft-deletable table this EXISTS/NOT EXISTS body's FROM/JOIN references, quoted or interpolated. */
function tableReferencesIn(body: string): TableRef[] {
  const refs: TableRef[] = [];
  tableRefQuoted.lastIndex = 0;
  let ref: RegExpExecArray | null;
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
    const sqlName = varName ? varToSqlName.get(varName) : undefined;
    if (!varName || !varNames.has(varName) || !sqlName) continue;
    const alias = cleanAlias(rawAlias);
    refs.push({
      table: sqlName,
      alias: alias ?? sqlName,
      aliasIsBare: Boolean(alias),
    });
  }
  return refs;
}

function guardedByDeletedAtPredicate(body: string, ref: TableRef): boolean {
  const guard = ref.aliasIsBare
    ? new RegExp(`\\b${ref.alias}\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`)
    : new RegExp(`"${ref.alias}"\\s*\\.\\s*"deletedAt"\\s+IS\\s+NULL`);
  return guard.test(body);
}

/** One EXISTS/NOT EXISTS occurrence's own guarded argument body, within its literal. */
function existsOccurrenceBody(
  literal: string,
  occurrence: RegExpMatchArray,
  nextStart: number,
): string {
  const localOpen = occurrence.index + occurrence[0].length - 1;
  const span = balancedSlice(literal, localOpen);
  return span
    ? literal.slice(span[0], span[1])
    : literal.slice(occurrence.index, nextStart);
}

function scanExistsOccurrencesInLiteral(
  literal: string,
  rangeStart: number,
  hasOptOut: (existsIndex: number) => boolean,
  seen: Set<string>,
): SoftDeleteViolation[] {
  const violations: SoftDeleteViolation[] = [];
  const existsPattern = /\b(NOT\s+)?EXISTS\s*\(/g;
  const occurrences = [...literal.matchAll(existsPattern)];

  for (const [idx, occ] of occurrences.entries()) {
    const existsIndex = rangeStart + occ.index;
    if (hasOptOut(existsIndex)) continue;
    const kind = occ[1] ? "NOT EXISTS" : "EXISTS";
    const nextStart = occurrences[idx + 1]?.index ?? literal.length;
    const body = existsOccurrenceBody(literal, occ, nextStart);

    for (const ref of tableReferencesIn(body)) {
      if (guardedByDeletedAtPredicate(body, ref)) continue;

      const key = `${existsIndex}:${ref.table}:${ref.alias}`;
      if (seen.has(key)) continue;
      seen.add(key);

      violations.push({
        start: existsIndex,
        detail: `raw sql ${kind}(… FROM/JOIN "${ref.table}" ${ref.aliasIsBare ? ref.alias : "(unaliased)"} …) is missing ${ref.aliasIsBare ? ref.alias : `"${ref.table}"`}."deletedAt" IS NULL`,
      });
    }
  }
  return violations;
}

function scanSqlTemplates(text: string): SoftDeleteViolation[] {
  if (!text.includes("EXISTS")) return [];
  const hasOptOut = (existsIndex: number) =>
    text.slice(Math.max(0, existsIndex - 200), existsIndex).includes(OPT_OUT);
  const seen = new Set<string>();

  return allTemplateRanges(text).flatMap(([rangeStart, rangeEnd]) =>
    scanExistsOccurrencesInLiteral(
      text.slice(rangeStart, rangeEnd),
      rangeStart,
      hasOptOut,
      seen,
    ),
  );
}

function scanSoftDeleteViolations(text: string): SoftDeleteViolation[] {
  return [...scanDrizzleExistsCalls(text), ...scanSqlTemplates(text)];
}

/** Require soft-delete filters on EXISTS subqueries over soft-deletable tables. */
export const requireSoftDeleteFilterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require a soft-delete filter (notDeleted/deletedAt, or an audited includes-deleted comment) on EXISTS subqueries over soft-deletable tables.",
    },
    messages: {
      missingSoftDeleteFilter:
        '{{detail}}. Add notDeleted(<table>) inside the subquery\'s where() (Drizzle form) or an alias."deletedAt" IS NULL predicate (raw sql form), or mark the subquery with an "includes-deleted: <reason>" comment if it genuinely must see deleted rows.',
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const violation of scanSoftDeleteViolations(
          context.sourceCode.text,
        )) {
          context.report({
            loc: context.sourceCode.getLocFromIndex(violation.start),
            messageId: "missingSoftDeleteFilter",
            data: { detail: violation.detail },
          });
        }
      },
    };
  },
});

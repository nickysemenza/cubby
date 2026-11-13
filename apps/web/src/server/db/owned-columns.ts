/**
 * The repository boundary for reconciler-owned columns (ADR 0029 section 2):
 * only the kernel's apply step writes a column a registered reconciler owns.
 * Every statement on every traced pool passes `guardOwnedWrites` before it
 * runs, so the refusal covers builder writes, raw SQL and helpers alike. The
 * owned set comes from the reconcilers registered in `kernel/modules.ts`, so
 * it switches on per domain as each module is added.
 */
import { inKernelApply } from "./kernel-apply-context";

export type OwnedColumn = {
  schema: string | null;
  table: string;
  column: string;
  scope: string;
};

/** `schema.table` (or `table`) → column → owning scope kind. */
const owned = new Map<string, Map<string, string>>();
let production: Promise<void> | null = null;

const tableId = (schema: string | null, table: string) =>
  schema ? `${schema}.${table}` : table;

/** Add a registry's owned columns; called when a kernel is built. */
export function registerOwnedColumns(columns: readonly OwnedColumn[]): void {
  for (const entry of columns) {
    const id = tableId(entry.schema, entry.table);
    const byColumn = owned.get(id) ?? new Map<string, string>();
    byColumn.set(entry.column, entry.scope);
    owned.set(id, byColumn);
  }
}

export class OwnedColumnWriteError extends Error {
  override name = "OwnedColumnWriteError";
}

type Token =
  | { kind: "word"; value: string; quoted: boolean }
  | { kind: "punct"; value: string }
  | { kind: "param"; index: number }
  | { kind: "other" };

/** Identifiers, keywords and punctuation; literals and comments are skipped. */
function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (/\s/u.test(char)) {
      index++;
    } else if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (char === "'" || char === '"') {
      let end = index + 1;
      let value = "";
      for (; end < sql.length; end++) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            value += char;
            end++;
            continue;
          }
          break;
        }
        value += sql[end];
      }
      tokens.push(
        char === '"'
          ? { kind: "word", value, quoted: true }
          : { kind: "other" },
      );
      index = end + 1;
    } else if (/[A-Za-z_]/u.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_$]*/u.exec(sql.slice(index))!;
      tokens.push({ kind: "word", value: match[0], quoted: false });
      index += match[0].length;
    } else if (char === "$" && /\d/u.test(sql[index + 1] ?? "")) {
      const match = /^\$(\d+)/u.exec(sql.slice(index))!;
      tokens.push({ kind: "param", index: Number(match[1]) - 1 });
      index += match[0].length;
    } else if ("(),;.=:".includes(char)) {
      tokens.push({ kind: "punct", value: char });
      index++;
    } else {
      tokens.push({ kind: "other" });
      index++;
    }
  }
  return tokens;
}

const isKeyword = (token: Token | undefined, keyword: string) =>
  token?.kind === "word" &&
  !token.quoted &&
  token.value.toLowerCase() === keyword;
const isPunct = (token: Token | undefined, value: string) =>
  token?.kind === "punct" && token.value === value;
/** Postgres folds an unquoted identifier to lower case. */
const identifier = (token: Token) =>
  token.kind === "word"
    ? token.quoted
      ? token.value
      : token.value.toLowerCase()
    : null;

/** A table reference at `start`: its id and the index after it. */
function tableRef(
  tokens: Token[],
  start: number,
): { id: string; next: number } | null {
  const first = tokens[start];
  if (!first || first.kind !== "word") return null;
  if (isPunct(tokens[start + 1], ".") && tokens[start + 2]?.kind === "word")
    return {
      id: tableId(identifier(first), identifier(tokens[start + 2]!)!),
      next: start + 3,
    };
  return { id: identifier(first)!, next: start + 1 };
}

const SET_END = new Set(["where", "from", "returning", "on"]);

/** The columns a `SET` list assigns, from the token after `SET`. */
function assigned(tokens: Token[], start: number): string[] {
  const columns: string[] = [];
  let depth = 0;
  let expectColumn = true;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (depth === 0 && expectColumn) {
      expectColumn = false;
      if (isPunct(token, "(")) {
        for (
          index++;
          index < tokens.length && !isPunct(tokens[index], ")");
          index++
        ) {
          const name = identifier(tokens[index]!);
          if (name) columns.push(name);
        }
        continue;
      }
      const name = identifier(token);
      if (name) columns.push(name);
      continue;
    }
    if (isPunct(token, "(")) depth++;
    else if (isPunct(token, ")")) {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && isPunct(token, ",")) expectColumn = true;
    else if (depth === 0 && isPunct(token, ";")) break;
    else if (
      depth === 0 &&
      token.kind === "word" &&
      !token.quoted &&
      SET_END.has(token.value.toLowerCase())
    )
      break;
  }
  return columns;
}

/**
 * Whether one inserted value writes its column: `DEFAULT`, `NULL` or a bound
 * null leaves it unset (an ORM insert lists every column).
 */
function insertsValue(
  expression: readonly Token[],
  params: readonly unknown[],
): boolean {
  if (
    expression.length === 1 &&
    (isKeyword(expression[0], "default") || isKeyword(expression[0], "null"))
  )
    return false;
  const bound = expression.filter((token) => token.kind === "param");
  const literal = expression.some(
    (token) =>
      token.kind === "other" ||
      (token.kind === "word" && !token.quoted && !isCast(token)),
  );
  if (bound.length === 1 && !literal) {
    const token = bound[0]!;
    return (
      token.kind === "param" &&
      params[token.index] !== null &&
      params[token.index] !== undefined
    );
  }
  return true;
}
/** Type names after `::` are casts, not values. */
const CAST_WORDS = new Set([
  "text",
  "uuid",
  "jsonb",
  "json",
  "timestamp",
  "date",
  "integer",
  "bigint",
  "numeric",
  "boolean",
  "double",
  "precision",
  "int",
  "real",
]);
const isCast = (token: Token) =>
  token.kind === "word" && CAST_WORDS.has(token.value.toLowerCase());

/** Columns a statement writes per table: `*` for an insert with no column list. */
function writtenColumns(
  sql: string,
  params: readonly unknown[] = [],
): Map<string, Set<string>> {
  const tokens = tokenize(sql);
  const written = new Map<string, Set<string>>();
  const add = (table: string, columns: readonly string[]) => {
    const set = written.get(table) ?? new Set<string>();
    for (const column of columns) set.add(column);
    written.set(table, set);
  };
  for (let index = 0; index < tokens.length; index++) {
    if (isKeyword(tokens[index], "update")) {
      let at = index + 1;
      if (isKeyword(tokens[at], "only")) at++;
      const ref = tableRef(tokens, at);
      if (!ref) continue;
      at = ref.next;
      if (isKeyword(tokens[at], "as")) at++;
      if (tokens[at]?.kind === "word" && !isKeyword(tokens[at], "set")) at++;
      if (isKeyword(tokens[at], "set")) add(ref.id, assigned(tokens, at + 1));
    } else if (
      isKeyword(tokens[index], "insert") &&
      isKeyword(tokens[index + 1], "into")
    ) {
      const ref = tableRef(tokens, index + 2);
      if (!ref) continue;
      let at = ref.next;
      if (isKeyword(tokens[at], "as")) at += 2;
      if (!isPunct(tokens[at], "(")) {
        add(ref.id, ["*"]);
        continue;
      }
      const columns: string[] = [];
      for (at++; at < tokens.length && !isPunct(tokens[at], ")"); at++) {
        const name = identifier(tokens[at]!);
        if (name) columns.push(name);
      }
      if (isKeyword(tokens[at + 1], "values")) {
        // A column is written when any row gives it a value.
        const set = new Set<string>();
        for (at += 2; isPunct(tokens[at], "(");) {
          let depth = 0;
          let expression: Token[] = [];
          let position = 0;
          for (at++; at < tokens.length; at++) {
            const token = tokens[at]!;
            if (depth === 0 && (isPunct(token, ",") || isPunct(token, ")"))) {
              if (insertsValue(expression, params) && columns[position])
                set.add(columns[position]!);
              position++;
              expression = [];
              if (isPunct(token, ")")) break;
              continue;
            }
            if (isPunct(token, "(")) depth++;
            else if (isPunct(token, ")")) depth--;
            expression.push(token);
          }
          at++;
          if (isPunct(tokens[at], ",")) at++;
        }
        at--;
        add(ref.id, [...set]);
      } else add(ref.id, columns);
      // `ON CONFLICT … DO UPDATE SET` writes too.
      let depth = 0;
      for (at++; at < tokens.length; at++) {
        if (isPunct(tokens[at], "(")) depth++;
        else if (isPunct(tokens[at], ")")) {
          if (depth === 0) break;
          depth--;
        } else if (depth === 0 && isPunct(tokens[at], ";")) break;
        else if (
          depth === 0 &&
          isKeyword(tokens[at], "do") &&
          isKeyword(tokens[at + 1], "update") &&
          isKeyword(tokens[at + 2], "set")
        ) {
          add(ref.id, assigned(tokens, at + 3));
          break;
        }
      }
    }
  }
  return written;
}

/** Owned columns a statement writes, as `table.column → scope`. */
function ownedWrites(sql: string, params: readonly unknown[]): string[] {
  if (!owned.size || !/\b(?:update|insert)\b/iu.test(sql)) return [];
  const hits: string[] = [];
  for (const [table, columns] of writtenColumns(sql, params)) {
    const byColumn =
      owned.get(table) ?? owned.get(table.replace(/^public\./u, ""));
    if (!byColumn) continue;
    for (const [column, scope] of byColumn)
      if (columns.has("*") || columns.has(column))
        hits.push(`${table}.${column} (${scope})`);
  }
  return hits;
}

/**
 * Refuse a statement that writes a reconciler-owned column outside the
 * kernel's apply step. The first write in an isolate loads the production
 * module list, whose registry registers its owned columns.
 */
export async function guardOwnedWrites(
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  if (inKernelApply() || !/\b(?:update|insert)\b/iu.test(sql)) return;
  production ??= import("~/server/kernel/kernel").then(async (kernel) => {
    await kernel.productionKernel();
  });
  await production;
  const hits = ownedWrites(sql, params);
  if (hits.length)
    throw new OwnedColumnWriteError(
      `Only the kernel's apply step writes reconciler-owned columns: ${hits.join(", ")}. Append evidence or record a decision instead.`,
    );
}

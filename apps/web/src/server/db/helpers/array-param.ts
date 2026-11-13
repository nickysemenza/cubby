import { sql, type SQL } from "drizzle-orm";

// A dependency-free leaf: computed SQL loaded by db tooling imports these
// without pulling the repository runtime and its environment.

export const arrayElement = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const arrayLiteral = (values: readonly string[]) =>
  `{${[...new Set(values)].map(arrayElement).join(",")}}`;

/**
 * A Postgres `text[]` literal bound as ONE parameter. Every element is quoted,
 * so commas, braces, empty strings and the text `NULL` stay literal values.
 */
export const textArrayParam = (values: readonly string[]): SQL =>
  sql`${arrayLiteral(values)}::text[]`;

/**
 * Values compared against a typed column as ONE untyped array literal, so
 * Postgres resolves the element type from the column (enum, uuid, integer,
 * date). Only for `column = ANY(...)`: a bare expression has no type to infer.
 */
export const columnArrayParam = (values: readonly unknown[]): SQL =>
  sql`${arrayLiteral(
    values.map((value) =>
      value instanceof Date ? value.toISOString() : String(value),
    ),
  )}`;

/** Parallel unnest columns must retain repeated values and their positions. */
export const orderedTextArrayParam = (values: readonly string[]): SQL =>
  sql`${`{${values.map(arrayElement).join(",")}}`}::text[]`;

/**
 * Generic Postgres error translation.
 *
 * Drizzle surfaces driver failures as "Failed query: … params: …" and hides the
 * real Postgres error (code, constraint, detail) in a nested `cause`. This module
 * digs that out and turns common constraint violations into clear, user-facing
 * messages. Wired as a global tRPC middleware (see trpc.ts) so every mutation
 * benefits — no per-router error handling needed.
 *
 * Entity-specific handlers (e.g. product NDB/UPC, which name the conflicting
 * record and suggest a merge) still run first inside their repos; because they
 * throw a translated TRPCError, this generic layer leaves them untouched.
 */

import type { TRPCError } from "@trpc/server";
import { createAppError } from "./app-error";

interface PgError {
  code: string;
  constraint?: string;
  detail?: string;
  table?: string;
  column?: string;
}

/** Walk an error's `cause` chain for a Postgres error (5-digit SQLSTATE code). */
function findPgError(error: unknown): PgError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    if (typeof current === "object") {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
        return current as PgError;
      }
    }
    current = (current as { cause?: unknown })?.cause;
  }
  return null;
}

/** "ProductExternalId" -> "product external id" for prose. */
function prettyTable(table?: string): string {
  if (!table) return "record";
  return table.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

/** "a"/"an" for prose, based on the leading sound of the word. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "An" : "A";
}

/** Extract the column list from a Postgres detail like `Key (a, b)=(...)`. */
function columnsFromDetail(detail?: string): string | null {
  const match = detail?.match(/Key \(([^)]+)\)=/);
  return match?.[1] ?? null;
}

/** Extract the referenced table from an FK detail (`… in table "Ingredient".`). */
function referencedTableFromDetail(detail?: string): string | null {
  const match = detail?.match(/in table "([^"]+)"/);
  return match ? prettyTable(match[1]) : null;
}

/**
 * Translate a database constraint violation into a friendly TRPCError, or return
 * null if the error isn't a recognized Postgres constraint error (so the caller
 * can rethrow the original).
 */
export function translateDatabaseError(error: unknown): TRPCError | null {
  const pg = findPgError(error);
  if (!pg) return null;

  const entity = prettyTable(pg.table);

  switch (pg.code) {
    case "23505": {
      // unique_violation
      const cols = columnsFromDetail(pg.detail);
      const a = article(entity);
      return createAppError(
        "DUPLICATE_RECORD",
        cols
          ? `${a} ${entity} with that ${cols} already exists.`
          : `${a} ${entity} with these details already exists.`,
        error,
      );
    }
    case "23503": {
      // foreign_key_violation
      const refTable = referencedTableFromDetail(pg.detail);
      return createAppError(
        "REFERENCED_RECORD_MISSING",
        refTable
          ? `This references a ${refTable} that doesn't exist.`
          : "This references a record that doesn't exist.",
        error,
      );
    }
    case "23502": {
      // not_null_violation
      return createAppError(
        "REQUIRED_FIELD_MISSING",
        pg.column
          ? `${pg.column} is required.`
          : "A required field is missing.",
        error,
      );
    }
    case "23514": {
      // check_violation
      return createAppError(
        "CONSTRAINT_VIOLATION",
        `This ${entity} fails a validation rule${
          pg.constraint ? ` (${pg.constraint})` : ""
        }.`,
        error,
      );
    }
    default:
      return null;
  }
}

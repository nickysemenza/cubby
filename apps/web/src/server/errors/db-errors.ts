/**
 * Generic Postgres error translation.
 *
 * Drizzle surfaces driver failures as "Failed query: … params: …" and hides the
 * real Postgres error (code, constraint, detail) in a nested `cause`. This module
 * digs that out and turns common constraint violations into clear, user-facing
 * messages. Applied at the Start operation boundary so every mutation
 * benefits — no per-router error handling needed.
 *
 * Entity-specific handlers (e.g. product NDB/UPC, which name the conflicting
 * record and suggest a merge) still run first inside their repos.
 */

import { z } from "zod";

import { type AppError, createAppError } from "./app-error";

const unparsedDatabaseErrorSchema = z.unknown();
const databaseErrorNodeSchema = z
  .object({
    code: z.string().optional(),
    constraint: z.string().optional(),
    detail: z.string().optional(),
    table: z.string().optional(),
    column: z.string().optional(),
    cause: z
      .union([z.instanceof(Error), z.object({}).passthrough()])
      .optional(),
  })
  .passthrough();
const postgresErrorSchema = databaseErrorNodeSchema.extend({
  code: z.string().regex(/^[0-9A-Z]{5}$/),
});

export type UnparsedDatabaseError = z.input<typeof unparsedDatabaseErrorSchema>;
type PgError = z.output<typeof postgresErrorSchema>;

/** Walk an error's `cause` chain for a Postgres error (5-digit SQLSTATE code). */
function findPgError(error: UnparsedDatabaseError, depth = 0): PgError | null {
  if (depth >= 8) return null;
  const parsedPostgresError = postgresErrorSchema.safeParse(error);
  if (parsedPostgresError.success) return parsedPostgresError.data;

  const parsedNode = databaseErrorNodeSchema.safeParse(error);
  if (!parsedNode.success || parsedNode.data.cause === undefined) return null;
  return findPgError(parsedNode.data.cause, depth + 1);
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
  return match?.[1] ? prettyTable(match[1]) : null;
}

/**
 * True if `error` is (or wraps) a Postgres unique-violation (23505), optionally
 * scoped to a specific constraint/index name. Find-then-insert helpers use this
 * to recover from a lost create race: when a concurrent request created the same
 * row between our SELECT and INSERT, the INSERT's transaction aborts on the
 * unique index — caller re-SELECTs the committed winner instead of 500ing.
 */
export function isUniqueViolation(
  error: UnparsedDatabaseError,
  constraint?: string,
): boolean {
  const pg = findPgError(error);
  if (pg?.code !== "23505") return false;
  return constraint ? pg.constraint === constraint : true;
}

/** True when Postgres aborted a SERIALIZABLE transaction as a stale snapshot. */
export function isSerializationFailure(error: UnparsedDatabaseError): boolean {
  return findPgError(error)?.code === "40001";
}

/**
 * Run a compound creator with cross-request race recovery. For find-then-create
 * flows where the create is NOT a single insert (so `findOrCreate`'s ON CONFLICT
 * can't reach it) — e.g. `createRecipe`, which inserts a recipe plus sections in
 * its OWN transaction.
 *
 * If `create` throws a unique-violation (optionally scoped to `constraint`), a
 * concurrent request created the same row between the caller's SELECT and this
 * INSERT. `recover` then runs fresh statements to load and return/update the
 * committed winner.
 *
 * IMPORTANT: `recover` must run on a clean connection, so this is safe only when
 * a failed `create` leaves no poisoned, still-open transaction behind. That
 * holds when `create` either (a) wraps its own transaction — the abort rolls it
 * back, e.g. `createRecipe`; or (b) runs as standalone auto-commit statements
 * with no outer transaction, e.g. `quickCreateProduct` under `findOrCreateByUPC`
 * (a single failed INSERT commits nothing). Do NOT use it for a `create` that
 * runs inside the caller's *open* transaction — the violation poisons that txn
 * and `recover`'s queries would error. Re-throws anything that isn't a matching
 * unique violation.
 */
export async function runWithConflictRecovery<T>(
  create: () => Promise<T>,
  recover: (error: UnparsedDatabaseError) => Promise<T>,
  constraint?: string,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!isUniqueViolation(error, constraint)) throw error;
    return await recover(error);
  }
}

/**
 * Translate a database constraint violation into a friendly AppError, or return
 * null if the error isn't a recognized Postgres constraint error (so the caller
 * can rethrow the original).
 */
export function translateDatabaseError(
  error: UnparsedDatabaseError,
): AppError | null {
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
      if (
        pg.constraint === "ProjectDependency_no_self_check" ||
        pg.constraint === "TaskDependency_no_self_check"
      ) {
        return createAppError(
          "SELF_DEPENDENCY",
          "A dependency cannot point to itself.",
          error,
        );
      }
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

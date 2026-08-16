/**
 * Shortcode minting — the write half of the public-id layer.
 *
 * A shortcode is non-null, immutable, and never reused, including after a soft
 * delete. Two mechanisms enforce that together, and they are not redundant:
 *
 * 1. `generateUniqueShortcode` pre-checks against the WHOLE table — soft-deleted
 *    rows included — so a retired code is a permanent tombstone. (Before the
 *    2026-07 cutover this check filtered on `notDeleted`, which is how 269 codes
 *    ended up shared between a deleted row and a live one.)
 * 2. The `<Table>_shortcode_unique` index is authoritative. `insertWithShortcode`
 *    treats a violation of it as a lost race and retries with a fresh code rather
 *    than trusting the pre-check, which is only advisory across concurrent
 *    connections.
 *
 * The read half — resolving a code back to a row — lives in `shortcode-resolver`.
 */

import type { ShortcodeType } from "@cubby/shared";
import { generateShortcode } from "@cubby/shared";
import {
  eq,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
  wish,
} from "~/server/db/schema";

import {
  FindOrCreateConflictError,
  findOrCreate,
  insertAndReturn,
  isTransaction,
  unwrapDb,
} from "./database-helpers";

/** How many fresh codes to try before giving up. */
const MAX_RETRIES = 10;

/**
 * A table carrying a public shortcode column. Structural rather than a union of
 * the twelve concrete tables: indexing {@link SHORTCODE_TABLE} with a non-literal
 * entity yields that union, and drizzle can't pick a `select`/`inArray` overload
 * against a union of twelve differently-branded `id` columns.
 */
export type ShortcodeTable = PgTable & {
  id: PgColumn;
  shortcode: PgColumn;
  deletedAt: PgColumn;
};

/**
 * Every table with a public shortcode, keyed by the entity name used across the
 * manifest, the prefix registry, and the resolvers. `image` is absent on
 * purpose: its rows are only ever addressed through the entity that owns them.
 */
export const SHORTCODE_TABLE = {
  cookbook,
  expense,
  financialAccount,
  financialTransaction,
  ingredient,
  inventory: inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
  wish,
} as const satisfies Record<ShortcodeType, ShortcodeTable>;

export type ShortcodeTableFor<T extends ShortcodeType> =
  (typeof SHORTCODE_TABLE)[T];

/** Whether ANY row — live or soft-deleted — already holds this code. */
const shortcodeTaken = async (
  db: Database | DrizzleTransaction,
  table: ShortcodeTable,
  code: string,
): Promise<boolean> => {
  const existing = await unwrapDb(db)
    .select({ one: sql<number>`1` })
    .from(table)
    .where(eq(table.shortcode, code))
    .limit(1);
  return existing.length > 0;
};

/**
 * Generate a shortcode not yet held by any row of `entity`'s table.
 *
 * Advisory only — see the file header. Callers that insert should prefer
 * {@link insertWithShortcode}, which also survives losing the race.
 *
 * @throws if no free code is found after MAX_RETRIES attempts.
 */
export async function generateUniqueShortcode(
  db: Database | DrizzleTransaction,
  entity: ShortcodeType,
): Promise<string> {
  const table = SHORTCODE_TABLE[entity];
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generateShortcode(entity);
    if (!(await shortcodeTaken(db, table, code))) {
      return code;
    }
  }
  throw new Error(
    `Failed to generate a unique ${entity} shortcode after ${MAX_RETRIES} attempts`,
  );
}

/**
 * A Postgres unique-violation on the given table's shortcode index.
 *
 * Walks the `cause` chain rather than inspecting the thrown error directly:
 * drizzle wraps every failure in a `DrizzleQueryError` ("Failed query: insert
 * into …") and hangs the real `pg` error — the one carrying `code` and
 * `constraint` — off `.cause`. Reading only the top-level error means never
 * recognizing a collision, which silently turns the retry below into dead code.
 */
const isShortcodeCollision = (error: unknown, tableName: string): boolean => {
  const indexName = `${tableName}_shortcode_unique`;
  for (let cursor = error; cursor && typeof cursor === "object"; ) {
    const { code, constraint, message, cause } = cursor as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      code === "23505" &&
      // `constraint` is populated by node-postgres; the message check covers a
      // driver or wrapper that only preserves the text.
      (constraint === indexName || (message?.includes(indexName) ?? false))
    ) {
      return true;
    }
    cursor = cause;
  }
  return false;
};

/**
 * Insert a row, minting its shortcode and retrying if the DB rejects it.
 *
 * The retry is what makes the unique index authoritative rather than decorative:
 * `generateUniqueShortcode`'s pre-check can't see a code another connection is
 * about to commit, so the only reliable signal is the insert failing.
 *
 * When the caller already has a transaction open, each attempt runs inside a
 * SAVEPOINT (drizzle emits one for a nested `.transaction()`). Without it the
 * first 23505 would abort the caller's whole transaction and the retry would
 * fail with "current transaction is aborted" — the retry would be worse than
 * useless. Standalone inserts need no savepoint: a failed statement outside a
 * transaction poisons nothing, so they retry directly.
 */
/**
 * `findOrCreate` for a shortcode-bearing table, with the same collision retry.
 *
 * Needed because `findOrCreate`'s insert uses a bare `onConflictDoNothing()`,
 * which is NOT scoped to the `where` predicate's index. A shortcode collision
 * (unrelated to the name/alias match the caller is deduping on) therefore
 * silently inserts nothing, and the follow-up re-SELECT finds no row — surfacing
 * as a `FindOrCreateConflictError` rather than as the transparent retry the
 * caller wants. Retrying the whole find-or-create is correct: the `values` thunk
 * mints a fresh code each attempt, and if the conflict really was the name
 * index, the retry's SELECT finds the winner and returns it.
 *
 * A conflict is only ASSUMED to be the shortcode after checking that the minted
 * code is now taken. Every other unique index on the table produces the exact
 * same silent-insert symptom, so retrying on the symptom alone spends three
 * attempts and then blames the shortcode for someone else's collision — which
 * is precisely how a sub-recipe link ingredient colliding on `lower(name)`
 * reported itself as "3 shortcode collisions" (#716 follow-up). When the code
 * is free, the conflict was an index this `where` cannot see: that's a caller
 * bug, and it says so.
 */
export async function findOrCreateWithShortcode<T extends ShortcodeType>(
  db: Database | DrizzleTransaction,
  entity: T,
  opts: {
    where: SQL | undefined;
    /** Called per attempt; must NOT set `shortcode` — this mints it. */
    values: () =>
      | Omit<InferInsertModel<ShortcodeTableFor<T>>, "shortcode">
      | Promise<Omit<InferInsertModel<ShortcodeTableFor<T>>, "shortcode">>;
  },
): Promise<{ row: InferSelectModel<ShortcodeTableFor<T>>; created: boolean }> {
  const table = SHORTCODE_TABLE[entity] as ShortcodeTable;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Captured so the conflict path can ask whether THIS code is what collided,
    // rather than inferring it from the silent insert.
    let mintedShortcode: string | undefined;
    const result = await findOrCreate(db, table, {
      where: opts.where,
      values: async () => {
        mintedShortcode = await generateUniqueShortcode(db, entity);
        return {
          ...(await opts.values()),
          shortcode: mintedShortcode,
        } as InferInsertModel<ShortcodeTable>;
      },
    }).catch(async (error: unknown) => {
      if (!(error instanceof FindOrCreateConflictError)) throw error;
      if (mintedShortcode && (await shortcodeTaken(db, table, mintedShortcode)))
        return null; // the code we minted is gone — retry with a fresh one
      throw new Error(
        `findOrCreateWithShortcode(${entity}): the insert conflicted on a unique index that \`where\` does not cover (the minted shortcode was still free), so the winner cannot be re-found. Check every unique index on ${getTableName(table)} against the values being inserted.`,
        { cause: error },
      );
    });
    if (result) {
      return result as {
        row: InferSelectModel<ShortcodeTableFor<T>>;
        created: boolean;
      };
    }
  }
  throw new Error(
    `Failed to find-or-create ${entity} after ${MAX_RETRIES} shortcode collisions`,
  );
}

export async function insertWithShortcode<T extends ShortcodeType>(
  db: Database | DrizzleTransaction,
  entity: T,
  values: Omit<InferInsertModel<ShortcodeTableFor<T>>, "shortcode">,
): Promise<InferSelectModel<ShortcodeTableFor<T>>> {
  const table = SHORTCODE_TABLE[entity] as ShortcodeTable;
  const tableName = getTableName(table);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const shortcode = await generateUniqueShortcode(db, entity);
    const row = { ...values, shortcode } as InferInsertModel<ShortcodeTable>;
    try {
      const created = isTransaction(db)
        ? await db.transaction((savepoint) =>
            insertAndReturn(savepoint, table, row),
          )
        : await insertAndReturn(db, table, row);
      return created as InferSelectModel<ShortcodeTableFor<T>>;
    } catch (error) {
      if (!isShortcodeCollision(error, tableName)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Failed to insert ${entity} after ${MAX_RETRIES} shortcode collisions`,
    { cause: lastError },
  );
}

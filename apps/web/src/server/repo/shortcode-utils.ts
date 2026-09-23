/**
 * Shortcode minting — the write half of the public-id layer.
 *
 * A shortcode is non-null, immutable, and never reused, including after a soft
 * delete. Two mechanisms enforce that together, and they are not redundant:
 *
 * 1. `generateUniqueShortcode` pre-checks against the WHOLE table — soft-deleted
 *    rows included — so a retired code is a permanent tombstone. A pre-check
 *    filtered on `notDeleted` would let a retired code end up shared between a
 *    deleted row and a live one.
 * 2. The `<Table>_shortcode_unique` index is authoritative. `insertWithShortcode`
 *    treats a violation of it as a lost race and retries with a fresh code rather
 *    than trusting the pre-check, which is only advisory across concurrent
 *    connections.
 *
 * The read half — resolving a code back to a row — lives in `shortcode-resolver`.
 */

import type { ShortcodeFor, ShortcodeType } from "@cubby/shared";
import { generateShortcode, parseShortcodeFor } from "@cubby/shared";
import {
  eq,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { entityIdentity } from "~/server/db/schema";

import {
  FindOrCreateConflictError,
  findOrCreate,
  insertAndReturn,
  isTransaction,
  unwrapDb,
} from "./database-helpers";
import {
  SHORTCODE_TABLE,
  type ShortcodeTable,
  type ShortcodeTableFor,
} from "./shortcode-tables";

export { SHORTCODE_TABLE } from "./shortcode-tables";
export type { ShortcodeTable, ShortcodeTableFor } from "./shortcode-tables";

/** How many fresh codes to try before giving up. */
const MAX_RETRIES = 10;

export interface ShortcodeGeneratorPort {
  readonly generate: typeof generateShortcode;
}

const productionShortcodeGeneratorPort: ShortcodeGeneratorPort = {
  generate: generateShortcode,
};

export type ShortcodeRowFor<T extends ShortcodeType> = Omit<
  InferSelectModel<ShortcodeTableFor<T>>,
  "shortcode"
> & { shortcode: ShortcodeFor<T> };

const parseShortcodeRow = <T extends ShortcodeType>(
  entity: T,
  row: InferSelectModel<ShortcodeTableFor<T>>,
): ShortcodeRowFor<T> => {
  const { shortcode, ...rest } = row;
  return { ...rest, shortcode: parseShortcodeFor(entity, shortcode) };
};

/**
 * Whether any identity — live, soft-deleted, or hard-deleted — ever held this
 * code. Reads `Entity` rather than the payload table because a hard-deleted
 * payload's code survives only there.
 */
const shortcodeTaken = async (
  db: Database | DrizzleTransaction,
  code: string,
): Promise<boolean> => {
  const existing = await unwrapDb(db)
    .select({ one: sql<number>`1` })
    .from(entityIdentity)
    .where(eq(entityIdentity.shortcode, code))
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
export async function generateUniqueShortcode<T extends ShortcodeType>(
  db: Database | DrizzleTransaction,
  entity: T,
  generator: ShortcodeGeneratorPort = productionShortcodeGeneratorPort,
): Promise<ShortcodeFor<T>> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = generator.generate(entity);
    if (!(await shortcodeTaken(db, code))) {
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
const databaseErrorNodeSchema = z
  .object({
    code: z.string().optional(),
    constraint: z.string().optional(),
    message: z.string().optional(),
    cause: z
      .union([z.instanceof(Error), z.object({}).passthrough()])
      .optional(),
  })
  .passthrough();

const isShortcodeCollision = <TError>(
  error: TError,
  tableName: string,
  depth = 0,
): boolean => {
  if (depth >= 6) return false;
  const parsedError = databaseErrorNodeSchema.safeParse(error);
  if (!parsedError.success) return false;

  // The identity trigger's insert into `Entity` rejects a code whose payload
  // was hard-deleted, which the payload's own index can no longer see.
  const indexNames = [
    `${tableName}_shortcode_unique`,
    "Entity_shortcode_unique",
  ];
  const { code, constraint, message, cause } = parsedError.data;
  if (
    code === "23505" &&
    // `constraint` is populated by node-postgres; the message check covers a
    // driver or wrapper that only preserves the text.
    indexNames.some(
      (indexName) =>
        constraint === indexName || (message?.includes(indexName) ?? false),
    )
  ) {
    return true;
  }
  return cause === undefined
    ? false
    : isShortcodeCollision(cause, tableName, depth + 1);
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
 * attempts and then blames the shortcode for someone else's collision — a
 * sub-recipe link ingredient colliding on `lower(name)` can just as easily
 * report itself as a shortcode collision. When the code is free, the conflict
 * was an index this `where` cannot see: that's a caller bug, and it says so.
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
  generator: ShortcodeGeneratorPort = productionShortcodeGeneratorPort,
): Promise<{ row: ShortcodeRowFor<T>; created: boolean }> {
  // SAFETY: Drizzle cannot retain the correlation between generic entity T and
  // the generated table map's indexed union, while every generated member is
  // checked against ShortcodeTable at the declaration above.
  const table = SHORTCODE_TABLE[entity] as ShortcodeTable;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // Captured so the conflict path can ask whether THIS code is what collided,
    // rather than inferring it from the silent insert.
    let mintedShortcode: string | undefined;
    const result = await findOrCreate(db, table, {
      where: opts.where,
      values: async () => {
        mintedShortcode = await generateUniqueShortcode(db, entity, generator);
        // SAFETY: opts.values is the insert model for the same generic table;
        // this adapter adds its only omitted required field, shortcode.
        return {
          ...(await opts.values()),
          shortcode: mintedShortcode,
        } as InferInsertModel<ShortcodeTable>;
      },
    }).catch(async (error) => {
      if (!(error instanceof FindOrCreateConflictError)) throw error;
      if (mintedShortcode && (await shortcodeTaken(db, mintedShortcode)))
        return null; // the code we minted is gone — retry with a fresh one
      throw new Error(
        `findOrCreateWithShortcode(${entity}): the insert conflicted on a unique index that \`where\` does not cover (the minted shortcode was still free), so the winner cannot be re-found. Check every unique index on ${getTableName(table)} against the values being inserted.`,
        { cause: error },
      );
    });
    if (result) {
      return {
        // SAFETY: findOrCreate used SHORTCODE_TABLE[entity]; its returned row
        // therefore has the select model correlated with this same entity T.
        row: parseShortcodeRow(
          entity,
          result.row as InferSelectModel<ShortcodeTableFor<T>>,
        ),
        created: result.created,
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
  generator: ShortcodeGeneratorPort = productionShortcodeGeneratorPort,
): Promise<ShortcodeRowFor<T>> {
  // SAFETY: Drizzle cannot retain the correlation between generic entity T and
  // the generated table map's indexed union, while every generated member is
  // checked against ShortcodeTable at the declaration above.
  const table = SHORTCODE_TABLE[entity] as ShortcodeTable;
  const tableName = getTableName(table);

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const shortcode = await generateUniqueShortcode(db, entity, generator);
    // SAFETY: values is the insert model for this generic entity with only its
    // shortcode omitted; adding the schema-parsed branded shortcode completes it.
    const row = { ...values, shortcode } as InferInsertModel<ShortcodeTable>;
    try {
      const created = isTransaction(db)
        ? await db.transaction((savepoint) =>
            insertAndReturn(savepoint, table, row),
          )
        : await insertAndReturn(db, table, row);
      // SAFETY: insertAndReturn used SHORTCODE_TABLE[entity], so the selected
      // row remains correlated with the same generic entity T.
      return parseShortcodeRow(
        entity,
        created as InferSelectModel<ShortcodeTableFor<T>>,
      );
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

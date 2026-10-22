/**
 * Shortcode minting — the write half of the public-id layer.
 *
 * A shortcode is non-null, immutable, and never reused. Payload indexes and
 * the permanent Entity identity index enforce that, including tombstones.
 * Inserts mint a candidate directly and retry a rejected collision inside a
 * savepoint. An advisory preflight SELECT costs a round trip without closing
 * the race; only callers that need a free code before inserting use it.
 *
 * The read half — resolving a code back to a row — lives in `shortcode-resolver`.
 */

import type { ShortcodeFor, ShortcodeType } from "@cubby/shared";
import { generateShortcode, parseShortcodeFor } from "@cubby/shared";
import {
  eq,
  getTableColumns,
  getTableName,
  type InferInsertModel,
  type InferSelectModel,
  type SQL,
  sql,
} from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { entityIdentity } from "~/server/db/schema";
import {
  insertPayloadWithIdentity,
  isEntityShortcodeCollision,
} from "~/server/entity-kernel/repo/entity-identity-writer";
import { findPgError } from "~/server/errors/db-errors";

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
 * Find a payload first; otherwise create identity and payload atomically.
 * A name/alias race rolls back our candidate identity before re-reading the
 * winner. Only shortcode collisions are retried; unrelated SQL failures retain
 * their original diagnostics.
 */
export async function findOrCreateWithShortcode<T extends ShortcodeType>(
  db: Database | DrizzleTransaction,
  entity: T,
  opts: {
    where: SQL | undefined;
    /** Called only on create; must NOT set `shortcode` — this mints it. */
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

  const find = async () => {
    const rows = await unwrapDb(db)
      .select(getTableColumns(table))
      .from(table)
      .where(opts.where)
      .limit(1);
    // SAFETY: The projection is the full row of SHORTCODE_TABLE[entity].
    const [row] = rows as InferSelectModel<ShortcodeTableFor<T>>[];
    return row ? parseShortcodeRow(entity, row) : undefined;
  };
  const existing = await find();
  if (existing) return { row: existing, created: false };
  try {
    const row = await insertWithShortcode(
      db,
      entity,
      await opts.values(),
      generator,
    );
    return { row, created: true };
  } catch (error) {
    if (findPgError(error)?.code !== "23505") throw error;
    const winner = await find();
    if (winner) return { row: winner, created: false };
    throw error;
  }
}

/**
 * Supplies the shortcode identity only: required entity values, actor
 * snapshots and execution identity stay the caller's job, so tests prefer the
 * existing create/admission fixtures over a direct insert.
 */
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
    const shortcode = generator.generate(entity);
    // SAFETY: values is the insert model for this generic entity with only its
    // shortcode omitted; adding the schema-parsed branded shortcode completes it.
    const row = { ...values, shortcode } as InferInsertModel<ShortcodeTable> & {
      shortcode: ShortcodeFor<T>;
      id?: string;
      createdAt?: Date;
      deletedAt?: Date | null;
    };
    try {
      // Standalone writes also need a transaction: a rejected payload must
      // release its identity. Nested transactions isolate retries in savepoints.
      const created = await unwrapDb(db).transaction((tx) =>
        insertPayloadWithIdentity(tx, table, entity, row),
      );
      // SAFETY: The insert used SHORTCODE_TABLE[entity], so the selected
      // row remains correlated with the same generic entity T.
      return parseShortcodeRow(
        entity,
        created as InferSelectModel<ShortcodeTableFor<T>>,
      );
    } catch (error) {
      if (!isEntityShortcodeCollision(error, tableName)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Failed to insert ${entity} after ${MAX_RETRIES} shortcode collisions`,
    { cause: lastError },
  );
}

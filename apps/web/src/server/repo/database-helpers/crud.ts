/**
 * Database CRUD helper functions.
 * Insert, update, and batch operations with proper error handling.
 */

import type { ImageId } from "@cubby/schemas/identifiers";
import type {
  AnyColumn,
  InferInsertModel,
  InferSelectModel,
  SQL,
} from "drizzle-orm";
import { and, eq, getTableName, inArray, sql } from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { image } from "~/server/db/schema";
import { TraceNames, withTrace } from "~/server/tracing";

import { unwrapDb } from "./core";
import { notDeleted } from "./query";

/**
 * `findOrCreate` inserted nothing and then couldn't re-find a winner.
 *
 * Thrown, not returned, because it always means a broken assumption rather than
 * a race: the bare `ON CONFLICT DO NOTHING` swallows a violation of ANY unique
 * index on the table, so this fires when the index that actually conflicted is
 * one the caller's `where` cannot see. A type, not a message match — callers
 * distinguishing it from a genuine error (see `findOrCreateWithShortcode`)
 * shouldn't be coupled to the wording.
 */
export class FindOrCreateConflictError extends Error {
  constructor(readonly table: string) {
    super(
      `findOrCreate(${table}): insert conflicted but no matching row was found`,
    );
    this.name = "FindOrCreateConflictError";
  }
}

/**
 * Atomic find-or-create. The correct, race-free SELECT-then-INSERT primitive:
 *
 *   1. SELECT by `where` — return the row if found.
 *   2. Else INSERT ... ON CONFLICT DO NOTHING. The bare (target-less) form
 *      catches a violation of ANY of the table's unique indexes — including
 *      partial and functional (e.g. lower(name)) ones, which drizzle can't name
 *      as a conflict target — and raises no error, so it never poisons the
 *      surrounding transaction.
 *   3. On conflict (no row inserted), a concurrent request created the same row
 *      between our SELECT and INSERT. DO NOTHING blocked on its lock until it
 *      committed, so a fresh SELECT (READ COMMITTED) reliably finds the winner.
 *
 * Use this instead of a hand-rolled `findFirst` + `insertAndReturn`, which 500s
 * on the unique index when two requests create the same new row concurrently.
 * `where` must match the unique index that backs the race — it's how step 3
 * re-finds the winner; if a conflict fires that `where` can't see, it throws.
 *
 * `values` may be a thunk so expensive prep (e.g. shortcode generation) only
 * runs on the create path, not when the row already exists.
 */
export const findOrCreate = async <T extends PgTable>(
  db: Database | DrizzleTransaction,
  table: T,
  opts: {
    /** Predicate to find an existing row (and to re-find the winner on conflict). */
    where: SQL | undefined;
    /** Row to insert when none is found; a thunk defers prep to the create path. */
    values:
      | InferInsertModel<T>
      | (() => InferInsertModel<T> | Promise<InferInsertModel<T>>);
  },
): Promise<{ row: InferSelectModel<T>; created: boolean }> => {
  return withTrace(TraceNames.db("findOrCreate"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const client = unwrapDb(db);

    const [existing] = (await client
      .select()
      .from(table as PgTable)
      .where(opts.where)
      .limit(1)) as InferSelectModel<T>[];
    if (existing) {
      return { row: existing, created: false };
    }

    const values =
      typeof opts.values === "function" ? await opts.values() : opts.values;

    const [created] = (await client
      .insert(table)
      .values(values)
      .onConflictDoNothing()
      .returning()) as InferSelectModel<T>[];
    if (created) {
      span.setAttribute("db.created", true);
      return { row: created, created: true };
    }

    // Lost the create race: the winner is committed, so re-SELECT finds it.
    span.setAttribute("db.conflict", true);
    const [winner] = (await client
      .select()
      .from(table as PgTable)
      .where(opts.where)
      .limit(1)) as InferSelectModel<T>[];
    if (!winner) {
      throw new FindOrCreateConflictError(getTableName(table));
    }
    return { row: winner, created: false };
  });
};

/**
 * Insert a single record and return it.
 * Cleaner than manually destructuring the returning() array.
 * Accepts both Database and DrizzleTransaction.
 */
export const insertAndReturn = async <T extends PgTable>(
  db: Database | DrizzleTransaction,
  table: T,
  values: InferInsertModel<T>,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("insert"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const client = unwrapDb(db);
    const result = await client.insert(table).values(values).returning();
    const [created] = result as InferSelectModel<T>[];
    if (!created) {
      throw new Error("Failed to insert record");
    }
    return created;
  });
};

/**
 * Update a single record and return it.
 * Cleaner than manually destructuring the returning() array.
 * Accepts both Database and DrizzleTransaction.
 */
export const updateAndReturn = async <T extends PgTable>(
  db: Database | DrizzleTransaction,
  table: T,
  values: PgUpdateSetSource<T>,
  where: SQL | undefined,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("update"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const client = unwrapDb(db);
    // If no values to update, just fetch and return the existing record
    // This handles cases like image-only updates where the main table doesn't change
    if (Object.keys(values).length === 0) {
      span.setAttribute("db.noop", true);
      const result = await client
        .select()
        .from(table as PgTable)
        .where(where);
      const [existing] = result as InferSelectModel<T>[];
      if (!existing) {
        throw new Error("Failed to update record");
      }
      return existing;
    }

    const result = await client
      .update(table)
      .set(values)
      .where(where)
      .returning();
    const [updated] = result as InferSelectModel<T>[];
    if (!updated) {
      throw new Error("Failed to update record");
    }
    return updated;
  });
};

export const updateLiveAndReturn = async <
  T extends PgTable & { id: AnyColumn; deletedAt: AnyColumn },
>(
  db: Database | DrizzleTransaction,
  table: T,
  values: PgUpdateSetSource<T>,
  id: string,
): Promise<InferSelectModel<T>> => {
  return updateAndReturn(
    db,
    table,
    values,
    and(eq(table.id, id), notDeleted(table)),
  );
};

/**
 * Associates pending images with an entity by creating join table records
 * and updating image statuses to UPLOADED.
 *
 * This helper consolidates the pattern of:
 * 1. Creating records in a join table (productImage, recipeImage, locationImage)
 * 2. Updating image statuses from PENDING to UPLOADED
 *
 * `pendingImageIds` (despite the name) must already be raw `Image.id` uuids —
 * NOT public `IMG-` shortcodes. This function has two families of callers:
 * the create/update `pendingImageIds` flows (product/location/recipe/purchase),
 * which now receive public shortcodes over the wire and must resolve them via
 * `resolveAllPresent(tx, "image", …)` BEFORE calling this (the same pattern
 * already used for `imageOrder`/`removeImageIds` in `repo/location/crud.ts`);
 * and the internal attach paths (`associateImageWithEntity`,
 * `associateImagesWithProduct`/`associateImagesWithRecipe` below), which pass
 * a row's own `Image.id` straight from an insert and were NEVER shortcodes.
 * Resolving inside this function would silently no-op every one of those
 * internal callers — including `attach_file`, the MCP attachment path — since
 * a raw uuid never matches the `IMG-` shortcode pattern.
 *
 * `pendingImageIds` is typed `ImageId[]`, not `string[]`, for the same reason
 * `applyImageOrder`/`detachImagesFromEntity` are: it turns a caller that
 * forgets to resolve a public shortcode first into a compile error instead of
 * a runtime `invalid input syntax for type uuid`. That gap was real —
 * `repo/location/crud.ts`'s two `pendingImageIds` call sites shipped without
 * the resolve step and only surfaced via a failing integration test.
 */
export async function associatePendingImages<T extends PgTable>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  joinTable: T,
  parentIdField: string,
  parentId: string,
  pendingImageIds: ImageId[],
  startSortOrder = 0,
): Promise<void> {
  if (!pendingImageIds || pendingImageIds.length === 0) {
    return;
  }

  await dbOrTx.insert(joinTable).values(
    pendingImageIds.map((imageId, i) => ({
      [parentIdField]: parentId,
      imageId,
      sortOrder: startSortOrder + i,
    })) as InferInsertModel<T>[],
  );

  await dbOrTx
    .update(image)
    .set({ status: "UPLOADED" })
    .where(inArray(image.id, pendingImageIds));
}

/** Shape shared by the productImage/locationImage/recipeImage join tables. */
type ImageJoinTable = PgTable & {
  imageId: AnyColumn;
  sortOrder: AnyColumn;
  deletedAt: AnyColumn;
};

/**
 * Persist an explicit display order for an entity's images: each id in
 * `orderedImageIds` gets `sortOrder = index` (first = cover). Ids not listed
 * keep their existing sortOrder.
 *
 * `orderedImageIds` is typed `ImageId[]`, not `string[]`: every caller already
 * resolves the public `IMG-` shortcodes it receives (via `resolveAllPresent`)
 * before reaching here, since `joinTable.imageId` is an unbranded uuid column.
 * The brand turns a future caller that forgets that resolution into a compile
 * error instead of a silent `invalid input syntax for type uuid` at runtime.
 */
export async function applyImageOrder<T extends ImageJoinTable>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  joinTable: T,
  parentIdColumn: AnyColumn,
  parentId: string,
  orderedImageIds: ImageId[],
): Promise<void> {
  for (const [i, imageId] of orderedImageIds.entries()) {
    await dbOrTx
      .update(joinTable)
      .set({ sortOrder: i } as PgUpdateSetSource<T>)
      .where(
        and(
          eq(parentIdColumn, parentId),
          eq(joinTable.imageId, imageId),
          notDeleted(joinTable),
        ),
      );
  }
}

/**
 * Next free sortOrder for an entity's images — used so newly associated
 * images append after the existing ones instead of colliding at 0.
 */
export async function nextImageSortOrder(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  joinTable: ImageJoinTable,
  parentIdColumn: AnyColumn,
  parentId: string,
): Promise<number> {
  const [row] = await dbOrTx
    .select({ max: sql<number | null>`max(${joinTable.sortOrder})` })
    .from(joinTable)
    .where(and(eq(parentIdColumn, parentId), notDeleted(joinTable)));
  return (row?.max ?? -1) + 1;
}

/**
 * Batch update multiple records using SQL CASE WHEN pattern.
 * 99% reduction in database round-trips vs individual UPDATEs.
 *
 * Automatically chunks large batches to avoid query size limits.
 * Updates all specified fields plus updatedAt timestamp.
 */
export async function batchUpdateWithCaseWhen<
  TUpdate extends { id: string; [key: string]: unknown },
>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  table: PgTable,
  updates: TUpdate[],
  chunkSize = 250,
): Promise<number> {
  if (updates.length === 0) return 0;

  return withTrace(TraceNames.db("batchUpdateWithCaseWhen"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    span.setAttribute("db.total_updates", updates.length);

    let totalUpdated = 0;

    for (let i = 0; i < updates.length; i += chunkSize) {
      const batch = updates.slice(i, i + chunkSize);

      const columnNames = Object.keys(batch[0]!).filter((k) => k !== "id");

      const caseStatements: SQL[] = [];

      for (const columnName of columnNames) {
        // When all values are NULL, use simple SET column = NULL.
        // CASE WHEN with only NULL branches produces an untyped expression
        // that can fail type resolution for typed columns like real/float4.
        const allNull = batch.every((update) => update[columnName] === null);

        if (allNull) {
          caseStatements.push(sql`${sql.identifier(columnName)} = NULL`);
          continue;
        }

        const cases: SQL[] = [];

        for (const update of batch) {
          const value = update[columnName];
          // Cast values to head off Postgres type inference issues inside CASE:
          //   - numbers → ::real (float4 columns)
          //   - objects/arrays → JSON-encoded ::jsonb (jsonb columns, e.g.
          //     location.valuation). node-postgres would bind a bare object as
          //     untyped text, which Postgres can't coerce inside a CASE branch.
          //   - strings/other → bound as-is (text).
          const typedValue =
            typeof value === "number"
              ? sql`${value}::real`
              : value === null
                ? sql`NULL`
                : typeof value === "object"
                  ? sql`${JSON.stringify(value)}::jsonb`
                  : sql`${value}`;
          cases.push(
            sql`WHEN ${sql.identifier("id")} = ${update.id} THEN ${typedValue}`,
          );
        }

        caseStatements.push(
          sql`${sql.identifier(columnName)} = CASE ${sql.join(cases, sql` `)} END`,
        );
      }

      caseStatements.push(sql`${sql.identifier("updatedAt")} = NOW()`);

      const ids = batch.map((u) => u.id);

      await dbOrTx.execute(sql`
        UPDATE ${table}
        SET ${sql.join(caseStatements, sql`, `)}
        WHERE ${sql.identifier("id")} IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
      `);

      totalUpdated += batch.length;
    }

    span.setAttribute(
      "db.chunks_executed",
      Math.ceil(updates.length / chunkSize),
    );
    span.setAttribute("db.total_updated", totalUpdated);

    return totalUpdated;
  });
}

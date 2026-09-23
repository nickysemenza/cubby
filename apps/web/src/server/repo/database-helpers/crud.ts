import type { GalleryEntity } from "@cubby/schemas/entity-manifest";
/**
 * Database CRUD helper functions.
 * Insert, update, and batch operations with proper error handling.
 */
import type { ImageId } from "@cubby/schemas/identifiers";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { AttachableImageEntity } from "@cubby/schemas/image";
import type {
  AnyColumn,
  GetColumnData,
  InferInsertModel,
  InferSelectModel,
  SQL,
} from "drizzle-orm";
import {
  and,
  eq,
  getTableColumns,
  getTableName,
  inArray,
  sql,
} from "drizzle-orm";
import type { PgTable, PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type JSONType, z } from "zod";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { entityAttachment, image } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  resolveAllOrThrow,
  resolveAllPresent,
} from "~/server/repo/shortcode-resolver";
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
    values: () => InferInsertModel<T> | Promise<InferInsertModel<T>>;
  },
): Promise<{ row: InferSelectModel<T>; created: boolean }> => {
  return withTrace(TraceNames.db("findOrCreate"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const client = unwrapDb(db);

    // SAFETY: Drizzle's generic `from` conditional cannot prove a caller's
    // concrete PgTable has a selection, while every PgTable accepted here does.
    const existingResult = await client
      .select(getTableColumns(table))
      .from(table as PgTable)
      .where(opts.where)
      .limit(1);
    // SAFETY: Both supported Pg query-result HKTs execute an explicit full
    // column projection as a row array; their union hides that shared result.
    const [existing] = existingResult as InferSelectModel<T>[];
    if (existing) {
      return { row: existing, created: false };
    }

    const values = await opts.values();

    const createdResult = await client
      .insert(table)
      .values(values)
      .onConflictDoNothing()
      .returning(getTableColumns(table));
    // SAFETY: Both supported Pg query-result HKTs return the explicitly named
    // columns as rows; the HKT union erases only that common array container.
    const [created] = createdResult as InferSelectModel<T>[];
    if (created) {
      span.setAttribute("db.created", true);
      return { row: created, created: true };
    }

    // Lost the create race: the winner is committed, so re-SELECT finds it.
    span.setAttribute("db.conflict", true);
    // SAFETY: See the first select above; the same concrete table T is queried.
    const winnerResult = await client
      .select(getTableColumns(table))
      .from(table as PgTable)
      .where(opts.where)
      .limit(1);
    // SAFETY: This is the same explicit full projection from the unchanged T.
    const [winner] = winnerResult as InferSelectModel<T>[];
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
    const result = await client
      .insert(table)
      .values(values)
      .returning(getTableColumns(table));
    // SAFETY: Both Pg drivers return an explicit returning projection as rows;
    // the query-result HKT union cannot retain the shared array container.
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
      // SAFETY: Drizzle's generic `from` conditional cannot see that every
      // PgTable accepted here has a full selectable projection.
      const result = await client
        .select(getTableColumns(table))
        .from(table as PgTable)
        .where(where);
      // SAFETY: Both Pg drivers execute this explicit full projection as rows;
      // the query-result HKT union cannot retain the shared array container.
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
      .returning(getTableColumns(table));
    // SAFETY: Both Pg drivers return the explicit columns from this same T as
    // rows; only the query-result HKT union obscures their common container.
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
 * internal callers — including `attach_files`, the MCP attachment path — since
 * a raw uuid never matches the `IMG-` shortcode pattern.
 *
 * `pendingImageIds` is typed `ImageId[]`, not `string[]`, for the same reason
 * `applyImageOrder`/`detachImagesFromEntity` are: it turns a caller that
 * forgets to resolve a public shortcode first into a compile error instead of
 * a runtime `invalid input syntax for type uuid`. That gap was real —
 * `repo/location/crud.ts`'s two `pendingImageIds` call sites shipped without
 * the resolve step and only surfaced via a failing integration test.
 */
export type ImageJoinTable = PgTable & {
  id: AnyColumn;
  updatedAt: AnyColumn;
  imageId: AnyColumn;
  sortOrder: AnyColumn;
  deletedAt: AnyColumn;
};

export interface ImageJoinBinding<
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
> {
  table: TTable;
  parentIdColumn: TParentColumn;
  insertRow: (
    parentId: GetColumnData<TParentColumn>,
    imageId: ImageId,
    sortOrder: number,
  ) => InferInsertModel<TTable>;
  sortOrderUpdate: (sortOrder: number) => PgUpdateSetSource<TTable>;
}

const defineImageJoinBinding = <
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  binding: ImageJoinBinding<TTable, TParentColumn>,
) => binding;

const galleryBinding = (
  extraColumns: Pick<
    InferInsertModel<typeof entityAttachment>,
    "documentKind"
  > = {},
) =>
  defineImageJoinBinding({
    table: entityAttachment,
    parentIdColumn: entityAttachment.subjectEntityId,
    insertRow: (subjectEntityId, imageId, sortOrder) => ({
      subjectEntityId,
      imageId,
      sortOrder,
      role: "attachment" as const,
      ...extraColumns,
    }),
    sortOrderUpdate: (sortOrder) => ({ sortOrder }),
  });

/**
 * One binding per entity whose declaration says `images: "gallery"`. Every
 * binding targets the shared `EntityAttachment` table (ADR 0006); the
 * `satisfies Record<GalleryEntity, …>` still fails to compile when a gallery
 * entity has no binding, and Purchase keeps its default document kind.
 */
export const imageJoinBindings = {
  product: galleryBinding(),
  location: galleryBinding(),
  recipe: galleryBinding(),
  project: galleryBinding(),
  purchase: galleryBinding({ documentKind: "other" }),
  gardenEntry: galleryBinding(),
  meal: galleryBinding(),
  task: galleryBinding(),
} as const satisfies Record<GalleryEntity, { table: ImageJoinTable }>;

export async function associatePendingImages<
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
  pendingImageIds: ImageId[],
  startSortOrder = 0,
  options: { activate?: boolean } = {},
): Promise<void> {
  const requestedIds = [...new Set(pendingImageIds)];
  if (requestedIds.length === 0) {
    return;
  }

  const availableRows = await dbOrTx
    .select({
      id: image.id,
      status: image.status,
      storageStatus: image.storageStatus,
    })
    .from(image)
    .where(and(inArray(image.id, requestedIds), notDeleted(image)));
  const availableIds = new Set(availableRows.map(({ id }) => id));
  const unavailableIds = requestedIds.filter((id) => {
    const row = availableRows.find((candidate) => candidate.id === id);
    return (
      row === undefined ||
      (row.status !== "PENDING" && row.status !== "UPLOADED") ||
      row.storageStatus === "missing" ||
      row.storageStatus === "metadata_mismatch"
    );
  });
  if (unavailableIds.length > 0) {
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      `Cannot attach unavailable images: ${unavailableIds.join(", ")}`,
    );
  }

  const joinTable: ImageJoinTable = binding.table;
  const activeRows = await dbOrTx
    .select({ imageId: sql<ImageId>`${joinTable.imageId}` })
    .from(joinTable)
    .where(
      and(
        eq(binding.parentIdColumn, parentId),
        inArray(joinTable.imageId, requestedIds),
        notDeleted(joinTable),
      ),
    );
  const activeIds = new Set(activeRows.map(({ imageId }) => imageId));
  const newIds = requestedIds.filter(
    (imageId) => availableIds.has(imageId) && !activeIds.has(imageId),
  );

  if (newIds.length > 0) {
    const appendSortOrder = Math.max(
      startSortOrder,
      await nextImageSortOrder(dbOrTx, binding, parentId),
    );
    await dbOrTx
      .insert(binding.table)
      .values(
        newIds.map((imageId, index) =>
          binding.insertRow(parentId, imageId, appendSortOrder + index),
        ),
      )
      .onConflictDoNothing();
  }

  // Import commits hold the image row locks and activate every new image in
  // one final bulk update. Existing callers retain the historical promotion
  // behavior unless they explicitly opt out here.
  if (options.activate !== false && availableRows.length > 0) {
    await dbOrTx
      .update(image)
      .set({ status: "UPLOADED" })
      .where(
        inArray(
          image.id,
          availableRows.map(({ id }) => id),
        ),
      );
  }
}

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
export async function applyImageOrder<
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
  orderedImageIds: ImageId[],
): Promise<void> {
  for (const [sortOrder, imageId] of orderedImageIds.entries()) {
    await dbOrTx
      .update(binding.table)
      .set(binding.sortOrderUpdate(sortOrder))
      .where(
        and(
          eq(binding.parentIdColumn, parentId),
          eq(binding.table.imageId, imageId),
          notDeleted(binding.table),
        ),
      );
  }
}

/**
 * Next free sortOrder for an entity's images — used so newly associated
 * images append after the existing ones instead of colliding at 0.
 */
export async function nextImageSortOrder<
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
): Promise<number> {
  const joinTable: ImageJoinTable = binding.table;
  const [row] = await dbOrTx
    .select({ max: sql<number | null>`max(${joinTable.sortOrder})` })
    .from(joinTable)
    .where(and(eq(binding.parentIdColumn, parentId), notDeleted(joinTable)));
  return (row?.max ?? -1) + 1;
}

/**
 * The declared child-cascade edge for an entity's own attachments — pass this
 * in `removeEntity`'s `children` so a delete soft-deletes the associations and
 * reaps any Image row/R2 object the cascade orphaned. `removeEntity` discovers
 * the image column itself (via `imageJoinColumnFor` reading
 * `INCOMING_EDGES.image`).
 */
export const imageCascadeChild = (
  // Purchase's cascade counts distinguish `cascadedPurchaseImages` from its
  // sibling `cascadedPurchaseProducts` child — every other caller uses the
  // shared default.
  auditKey = "cascadedImages",
) =>
  ({
    table: entityAttachment,
    parentColumns: [entityAttachment.subjectEntityId],
    auditKey,
  }) as const;

/**
 * The shared image-sync body behind every gallery entity's update path:
 * reorder existing images (first = cover) → detach removed ones (reaping any
 * Image row/R2 object nothing else still references, via
 * `detachImagesFromEntity`) → attach newly pending ones, appended after the
 * reordered set. All three fields are public `IMG-` shortcodes, resolved to
 * uuids here — right before the lower-level helpers above, which still take
 * raw `Image.id`s.
 *
 * `unresolved` controls what an `IMG-` code that does not resolve to a live
 * Image does: `"drop"` (the default) silently ignores it, matching the
 * long-standing product/location/recipe/purchase behavior where a stale or
 * already-detached code is a no-op. `"throw"` surfaces
 * `REFERENCED_RECORD_MISSING` instead — gardenEntry's existing behavior,
 * preserved as-is by this extraction rather than silently loosened.
 */
export async function syncEntityImages<
  E extends GalleryEntity,
  TTable extends ImageJoinTable,
  TParentColumn extends AnyColumn,
>(
  tx: DrizzleTransaction,
  entity: E,
  binding: ImageJoinBinding<TTable, TParentColumn>,
  parentId: GetColumnData<TParentColumn>,
  data: {
    pendingImageIds?: readonly string[] | null;
    removeImageIds?: readonly string[] | null;
    imageOrder?: readonly string[] | null;
  },
  options?: { unresolved?: "drop" | "throw" },
): Promise<{ detachedImageKeys: string[] }> {
  const resolve = (codes: readonly string[]) =>
    options?.unresolved === "throw"
      ? resolveAllOrThrow(tx, "image", codes)
      : resolveAllPresent(tx, "image", codes);

  let detachedImageKeys: string[] = [];

  if (data.imageOrder?.length) {
    const orderedIds = await resolve(data.imageOrder);
    await applyImageOrder(tx, binding, parentId, orderedIds);
  }
  if (data.removeImageIds?.length) {
    const idsToRemove = await resolve(data.removeImageIds);
    // Dynamic, not a top-level import: `image.ts` imports this module (the
    // database-helpers barrel) for `imageJoinBindings` et al., so a static
    // import here would form a cycle — `image.ts`'s own top-level
    // `notDeleted(...)` relation config would run before this barrel's
    // `query.ts` export lands, crashing with "notDeleted is not a function".
    // Deferring the import to call time (long after both modules have
    // finished loading independently) avoids the mid-evaluation state
    // entirely.
    const { detachImagesFromEntity } = await import("~/server/repo/image");
    // `parseEntityRef` (a typed resolver, not an assertion) is what correlates
    // this generic `entity`/`parentId` pair into the properly branded ref
    // `detachImagesFromEntity` needs — `parentId` is already a validated brand
    // from the caller, so this is a re-derivation, not fresh validation.
    ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
      tx,
      parseEntityRef<AttachableImageEntity>(entity, parentId),
      idsToRemove,
    ));
  }
  if (data.pendingImageIds?.length) {
    const pendingIds = await resolve(data.pendingImageIds);
    const startSortOrder = await nextImageSortOrder(tx, binding, parentId);
    await associatePendingImages(
      tx,
      binding,
      parentId,
      pendingIds,
      startSortOrder,
    );
  }

  return { detachedImageKeys };
}

/**
 * Batch update multiple records using SQL CASE WHEN pattern.
 * 99% reduction in database round-trips vs individual UPDATEs.
 *
 * Automatically chunks large batches to avoid query size limits.
 * Updates all specified fields plus updatedAt timestamp.
 */
const batchUpdateValueSchema = z.json().optional();

const updateValueAt = <TUpdate extends { id: string }>(
  update: TUpdate,
  columnName: string,
): JSONType | undefined => {
  const entry = Object.entries(update).find(([key]) => key === columnName);
  return batchUpdateValueSchema.parse(entry?.[1]);
};

const isNumericUpdateValue = (value: JSONType | undefined): value is number =>
  typeof value === "number";

type JsonContainer = Extract<JSONType, readonly JSONType[] | object>;

const isJsonContainer = (value: JSONType | undefined): value is JsonContainer =>
  value !== null && typeof value === "object";

export async function batchUpdateWithCaseWhen<TUpdate extends { id: string }>(
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
        const allNull = batch.every(
          (update) => updateValueAt(update, columnName) === null,
        );

        if (allNull) {
          caseStatements.push(sql`${sql.identifier(columnName)} = NULL`);
          continue;
        }

        const cases: SQL[] = [];

        for (const update of batch) {
          const value = updateValueAt(update, columnName);
          // Cast values to head off Postgres type inference issues inside CASE:
          //   - numbers → ::real (float4 columns)
          //   - objects/arrays → JSON-encoded ::jsonb (jsonb columns, e.g.
          //     location.valuation). node-postgres would bind a bare object as
          //     untyped text, which Postgres can't coerce inside a CASE branch.
          //   - strings/other → bound as-is (text).
          const typedValue = isNumericUpdateValue(value)
            ? sql`${value}::real`
            : value === null
              ? sql`NULL`
              : isJsonContainer(value)
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

/**
 * Database CRUD helper functions.
 * Insert, update, and batch operations with proper error handling.
 */

import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { getTableName, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { FAILED_TO_INSERT, FAILED_TO_UPDATE } from "~/lib/error-messages";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { image, inventoryEntry } from "~/server/db/schema";
import { TraceNames, withTrace } from "~/server/tracing";

import { getDb } from "./core";

/**
 * Insert a single record and return it.
 * Cleaner than manually destructuring the returning() array.
 *
 * @param tx - Transaction instance
 * @param table - Table schema
 * @param values - Values to insert
 * @returns The created record
 */
export const insertAndReturn = async <T extends PgTable>(
  tx: DrizzleTransaction,
  table: T,
  values: InferInsertModel<T>,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("insert"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const result = await tx.insert(table).values(values).returning();
    const [created] = result as InferSelectModel<T>[];
    if (!created) {
      throw new Error(FAILED_TO_INSERT);
    }
    return created;
  });
};

/**
 * Insert multiple records in batch and return them.
 * Returns empty array if values array is empty.
 *
 * @param tx - Transaction instance
 * @param table - Table schema
 * @param values - Array of values to insert
 * @returns Array of created records
 */
export const batchInsert = async <T extends PgTable>(
  tx: DrizzleTransaction,
  table: T,
  values: InferInsertModel<T>[],
): Promise<InferSelectModel<T>[]> => {
  if (values.length === 0) return [];
  return withTrace(TraceNames.db("batchInsert"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    span.setAttribute("db.batch_size", values.length);
    const result = await tx.insert(table).values(values).returning();
    return result as InferSelectModel<T>[];
  });
};

/**
 * Insert a single record and return it (non-transaction version).
 * For use with Database instead of Transaction.
 *
 * @param db - Database instance
 * @param table - Table schema
 * @param values - Values to insert
 * @returns The created record
 */
export const insertAndReturnDb = async <T extends PgTable>(
  db: Database,
  table: T,
  values: InferInsertModel<T>,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("insert"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    const result = await getDb(db).insert(table).values(values).returning();
    const [created] = result as InferSelectModel<T>[];
    if (!created) {
      throw new Error(FAILED_TO_INSERT);
    }
    return created;
  });
};

/**
 * Update a single record and return it (transaction version).
 * Cleaner than manually destructuring the returning() array.
 *
 * @param tx - Transaction instance
 * @param table - Table schema
 * @param values - Values to update
 * @param where - Where clause (SQL condition)
 * @returns The updated record
 */
export const updateAndReturn = async <T extends PgTable>(
  tx: DrizzleTransaction,
  table: T,
  values: Partial<InferInsertModel<T>>,
  where: SQL | undefined,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("update"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    // If no values to update, just fetch and return the existing record
    // This handles cases like image-only updates where the main table doesn't change
    if (Object.keys(values).length === 0) {
      span.setAttribute("db.noop", true);
      const result = await tx
        .select()
        .from(table as PgTable)
        .where(where);
      const [existing] = result as InferSelectModel<T>[];
      if (!existing) {
        throw new Error(FAILED_TO_UPDATE);
      }
      return existing;
    }

    const result = await tx.update(table).set(values).where(where).returning();
    const [updated] = result as InferSelectModel<T>[];
    if (!updated) {
      throw new Error(FAILED_TO_UPDATE);
    }
    return updated;
  });
};

/**
 * Update a single record and return it (non-transaction version).
 * For use with Database instead of Transaction.
 *
 * @param db - Database instance
 * @param table - Table schema
 * @param values - Values to update
 * @param where - Where clause (SQL condition)
 * @returns The updated record
 */
export const updateAndReturnDb = async <T extends PgTable>(
  db: Database,
  table: T,
  values: Partial<InferInsertModel<T>>,
  where: SQL | undefined,
): Promise<InferSelectModel<T>> => {
  return withTrace(TraceNames.db("update"), async (span) => {
    span.setAttribute("db.table", getTableName(table));
    // If no values to update, just fetch and return the existing record
    // This handles cases like image-only updates where the main table doesn't change
    if (Object.keys(values).length === 0) {
      span.setAttribute("db.noop", true);
      const result = await getDb(db)
        .select()
        .from(table as PgTable)
        .where(where);
      const [existing] = result as InferSelectModel<T>[];
      if (!existing) {
        throw new Error(FAILED_TO_UPDATE);
      }
      return existing;
    }

    const result = await getDb(db)
      .update(table)
      .set(values)
      .where(where)
      .returning();
    const [updated] = result as InferSelectModel<T>[];
    if (!updated) {
      throw new Error(FAILED_TO_UPDATE);
    }
    return updated;
  });
};

/**
 * Associates pending images with an entity by creating join table records
 * and updating image statuses to UPLOADED.
 *
 * This helper consolidates the pattern of:
 * 1. Creating records in a join table (productImage, recipeImage, locationImage)
 * 2. Updating image statuses from PENDING to UPLOADED
 *
 * @param dbOrTx - Database client or transaction
 * @param joinTable - The join table to insert records into
 * @param parentIdField - Name of the parent ID field (e.g., "productId", "recipeId")
 * @param parentId - ID of the parent entity
 * @param pendingImageIds - Array of image IDs to associate
 *
 * @example
 * ```typescript
 * await associatePendingImages(
 *   tx,
 *   productImage,
 *   "productId",
 *   newProduct.id,
 *   pendingImageIds
 * );
 * ```
 */
export async function associatePendingImages<T extends PgTable>(
  dbOrTx: DrizzleClient | DrizzleTransaction,
  joinTable: T,
  parentIdField: string,
  parentId: string,
  pendingImageIds: string[],
): Promise<void> {
  if (!pendingImageIds || pendingImageIds.length === 0) {
    return;
  }

  // Create join table records in batch
  await dbOrTx.insert(joinTable).values(
    pendingImageIds.map((imageId) => ({
      [parentIdField]: parentId,
      imageId,
    })) as InferInsertModel<T>[],
  );

  // Update all image statuses to UPLOADED in batch
  await dbOrTx
    .update(image)
    .set({ status: "UPLOADED" })
    .where(inArray(image.id, pendingImageIds));
}

/**
 * Batch upsert inventory entries using PostgreSQL's ON CONFLICT.
 * More efficient than individual inserts/updates.
 *
 * Creates new inventory entries or updates existing ones based on the
 * unique constraint (productId, locationId).
 *
 * @param dbOrTx - Database client or transaction
 * @param entries - Array of inventory entries to upsert
 * @returns Array of upserted inventory entries
 *
 * @example
 * ```typescript
 * await batchUpsertInventory(tx, [
 *   {
 *     productId: "...",
 *     locationId: "...",
 *     amount: { value: 5, unit: "each" },
 *     valuation: 10.50
 *   }
 * ]);
 * ```
 */
export async function batchUpsertInventory<
  T extends {
    productId: string;
    locationId: string;
    amount: { value: number; unit: string };
    valuation: number | null;
  },
>(dbOrTx: DrizzleClient | DrizzleTransaction, entries: T[]): Promise<void> {
  if (entries.length === 0) return;

  return withTrace(TraceNames.db("batchUpsertInventory"), async (span) => {
    span.setAttribute("db.batch_size", entries.length);

    const now = new Date();
    const values = entries.map((entry) => ({
      productId: entry.productId,
      locationId: entry.locationId,
      amount: entry.amount,
      valuation: entry.valuation,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }));

    await dbOrTx
      .insert(inventoryEntry as PgTable)
      .values(values)
      .onConflictDoUpdate({
        target: [inventoryEntry.productId, inventoryEntry.locationId],
        set: {
          amount: sql`EXCLUDED.amount`,
          valuation: sql`EXCLUDED.valuation`,
          updatedAt: sql`EXCLUDED.updatedAt`,
        },
      });

    span.setAttribute("db.upserted_count", entries.length);
  });
}

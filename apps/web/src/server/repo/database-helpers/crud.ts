/**
 * Database CRUD helper functions.
 * Insert, update, and batch operations with proper error handling.
 */

import type { InferInsertModel, InferSelectModel, SQL } from "drizzle-orm";
import { getTableName, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import { image } from "~/server/db/schema";
import { TraceNames, withTrace } from "~/server/tracing";

import { unwrapDb } from "./core";

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
  values: Partial<InferInsertModel<T>>,
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

/**
 * Associates pending images with an entity by creating join table records
 * and updating image statuses to UPLOADED.
 *
 * This helper consolidates the pattern of:
 * 1. Creating records in a join table (productImage, recipeImage, locationImage)
 * 2. Updating image statuses from PENDING to UPLOADED
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

    // Process in chunks to avoid query size limits
    for (let i = 0; i < updates.length; i += chunkSize) {
      const batch = updates.slice(i, i + chunkSize);

      // Extract column names (all updates must have same columns)
      const columnNames = Object.keys(batch[0]!).filter((k) => k !== "id");

      // Build CASE WHEN for each column
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
          // Build: WHEN "id" = {id} THEN {value}
          // Cast numeric values to avoid Postgres type inference issues
          const typedValue =
            typeof value === "number"
              ? sql`${value}::real`
              : value === null
                ? sql`NULL`
                : sql`${value}`;
          cases.push(
            sql`WHEN ${sql.identifier("id")} = ${update.id} THEN ${typedValue}`,
          );
        }

        // Build: "columnName" = CASE WHEN ... END
        caseStatements.push(
          sql`${sql.identifier(columnName)} = CASE ${sql.join(cases, sql` `)} END`,
        );
      }

      // Add updatedAt timestamp
      caseStatements.push(sql`${sql.identifier("updatedAt")} = NOW()`);

      // Build WHERE IN clause
      const ids = batch.map((u) => u.id);

      // Execute batch UPDATE
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

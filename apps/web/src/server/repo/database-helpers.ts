import { ilike, type SQL, asc, desc, inArray } from "drizzle-orm";
import {
  type AnyColumn,
  type InferInsertModel,
  type InferSelectModel,
} from "drizzle-orm";
import { type PgTable } from "drizzle-orm/pg-core";
import { type SortParams } from "~/schemas/pagination";
import {
  type Database,
  type DrizzleClient,
  type DrizzleTransaction,
} from "~/server/db";
import { productUnitMappings, image } from "~/server/db/schema";
import { unsafeProductId } from "~/schemas/identifiers";

// Helper function to format search terms for PostgreSQL full-text search
export const formatSearchTerm = (
  column: AnyColumn,
  term?: string,
): SQL | undefined => {
  if (term === undefined || term.trim() === "") {
    return undefined;
  }
  return ilike(column, `%${term}%`);
};

// Helper function to get sort direction for a field
export const getSortDirection = (sort: SortParams, field: string) =>
  sort.orderBy === field ? sort.direction : undefined;

/**
 * Get the underlying Drizzle client from the opaque Database type.
 * This should ONLY be used within repo files to access the database.
 * Services and routers should never call this - they just pass Database around.
 */
export const getDb = (db: Database): DrizzleClient => {
  return db as unknown as DrizzleClient;
};

/**
 * Safely unwrap Database or use DrizzleTransaction directly.
 * Detects if the input is already a DrizzleTransaction and returns it,
 * otherwise unwraps the branded Database type.
 */
export const unwrapDb = (
  db: Database | DrizzleTransaction,
): DrizzleClient | DrizzleTransaction => {
  // Check if it's a transaction by looking for transaction-specific methods
  return "rollback" in db ? db : getDb(db);
};

/**
 * Transaction wrapper for interactive transactions (sequential operations).
 * Use this in repo functions when you need multiple operations to be atomic.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (tx: DrizzleTransaction) => Promise<T>,
): Promise<T> => {
  return await getDb(db).transaction(fn);
};

/**
 * Predefined relation loaders for common query patterns.
 * Reduces verbosity when fetching entities with their related data.
 *
 * Usage: spread into query options
 * Example: db.query.ingredient.findFirst({ where: ..., ...relations.ingredient.full })
 */
export const relations = {
  ingredient: {
    full: {
      with: {
        Product: {
          with: {
            unitMappings: true,
            images: {
              with: {
                image: true,
              },
            },
          },
        },
        Recipe: true,
        RecipeSectionIngredient: {
          with: {
            recipeSection: {
              with: {
                recipe: true,
              },
            },
          },
        },
      },
    },
  },
  product: {
    full: {
      with: {
        Ingredient: true,
        unitMappings: true,
        InventoryEntry: {
          with: {
            location: {
              with: {
                images: {
                  with: {
                    image: true,
                  },
                },
              },
            },
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
  },
  recipe: {
    full: {
      with: {
        sections: {
          with: {
            ingredients: {
              with: {
                ingredient: {
                  with: {
                    Recipe: true,
                  },
                },
              },
            },
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
  },
  location: {
    full: {
      with: {
        parent: true,
        children: true,
        InventoryEntries: {
          with: {
            Product: true,
          },
        },
        images: {
          with: {
            image: true,
          },
        },
      },
    },
    withImages: {
      with: {
        images: {
          with: {
            image: true,
          },
        },
      },
    },
  },
  inventory: {
    full: {
      with: {
        Product: {
          with: {
            unitMappings: true,
            images: {
              with: {
                image: true,
              },
            },
          },
        },
        location: {
          with: {
            images: {
              with: {
                image: true,
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Build order by clause from sort parameters.
 * Validates that the requested field is in the allowed list and returns
 * the appropriate asc/desc clause.
 *
 * @param table - The table schema
 * @param sort - Sort parameters (field and direction)
 * @param allowedFields - Array of field names that can be sorted on
 * @returns Array of order by clauses (empty if field not allowed)
 */
export const buildOrderBy = <T extends PgTable>(
  table: T,
  sort: SortParams,
  allowedFields: string[],
): SQL[] => {
  if (!allowedFields.includes(sort.orderBy)) {
    return [];
  }
  const column = table[sort.orderBy as keyof T] as AnyColumn | undefined;
  if (!column) return [];
  return [sort.direction === "asc" ? asc(column) : desc(column)];
};

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
  const result = await tx.insert(table).values(values).returning();
  const [created] = result as InferSelectModel<T>[];
  if (!created) {
    throw new Error("Failed to insert record");
  }
  return created;
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
  const result = await tx.insert(table).values(values).returning();
  return result as InferSelectModel<T>[];
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
  const result = await getDb(db).insert(table).values(values).returning();
  const [created] = result as InferSelectModel<T>[];
  if (!created) {
    throw new Error("Failed to insert record");
  }
  return created;
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
  const result = await tx.update(table).set(values).where(where).returning();
  const [updated] = result as InferSelectModel<T>[];
  if (!updated) {
    throw new Error("Failed to update record");
  }
  return updated;
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
  const result = await getDb(db)
    .update(table)
    .set(values)
    .where(where)
    .returning();
  const [updated] = result as InferSelectModel<T>[];
  if (!updated) {
    throw new Error("Failed to update record");
  }
  return updated;
};

/**
 * Extract image records from join table results.
 * Common pattern: join tables have { image: typeof image.$inferSelect }
 *
 * @param joinTableRecords - Array of join table records with image field
 * @returns Array of image records, or empty array if input is null/undefined
 *
 * @example
 * ```typescript
 * // Before
 * const productImages = images?.map((pi) => pi.image) ?? [];
 *
 * // After
 * const productImages = extractImagesFromJoinTable(images);
 * ```
 */
export const extractImagesFromJoinTable = <T extends { image: { id: string } }>(
  joinTableRecords: T[] | undefined | null,
): T["image"][] => {
  return joinTableRecords?.map((record) => record.image) ?? [];
};

/**
 * Map an array of DB records through a transformation function.
 * Handles null/undefined and returns empty array by default.
 *
 * @param records - Array of database records to transform
 * @param mapper - Transformation function for each record
 * @returns Transformed array, or empty array if input is null/undefined
 *
 * @example
 * ```typescript
 * // Before
 * const products = Product?.map((prod) => ({ ...transform })) ?? [];
 *
 * // After
 * const products = mapRelation(Product, (prod) => ({ ...transform }));
 * ```
 */
export const mapRelation = <TIn, TOut>(
  records: TIn[] | undefined | null,
  mapper: (record: TIn) => TOut,
): TOut[] => {
  return records?.map(mapper) ?? [];
};

/**
 * Add sourceMetadata to unit mappings for a product.
 * Injects { type: "product", productId } into each mapping's sourceMetadata field.
 *
 * @param productId - The product ID (raw string from database)
 * @param unitMappings - Array of product unit mappings
 * @returns Unit mappings with sourceMetadata injected
 *
 * @example
 * ```typescript
 * // Before
 * unitMappings: prod.unitMappings.map((mapping) => ({
 *   ...mapping,
 *   sourceMetadata: {
 *     type: "product" as const,
 *     productId: unsafeProductId(prod.id),
 *   },
 * }))
 *
 * // After
 * unitMappings: addProductSourceMetadata(prod.id, prod.unitMappings)
 * ```
 */
export const addProductSourceMetadata = (
  productId: string,
  unitMappings: Array<typeof productUnitMappings.$inferSelect>,
) => {
  return unitMappings.map((mapping) => ({
    ...mapping,
    sourceMetadata: {
      type: "product" as const,
      productId: unsafeProductId(productId),
    },
  }));
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
 * Executes a data query and count query in parallel and wraps results in the standard
 * paginated list response format.
 *
 * This helper consolidates the common pattern of running two queries in parallel:
 * 1. The main data query (with pagination, filtering, sorting)
 * 2. The count query (total matching records without pagination)
 *
 * Note: If you need to transform results before returning, pass the transformation
 * as part of the data query promise chain, or manually destructure and transform.
 *
 * @param dataQuery - Promise that resolves to the array of data records
 * @param countQuery - Promise that resolves to array with count result
 * @returns Object with data array and total count
 *
 * @example
 * ```typescript
 * // Simple case - no transformation needed
 * return await executeListQueryWithCount(
 *   getDb(db).query.recipe.findMany({ where, orderBy, limit, offset }),
 *   getDb(db).select({ count: count() }).from(recipe).where(where)
 * );
 *
 * // With transformation - transform in the promise chain
 * const { data, count } = await executeListQueryWithCount(
 *   getDb(db).query.product.findMany({ where, orderBy, limit, offset })
 *     .then(results => Promise.all(results.map(r => transformToAPI(r)))),
 *   getDb(db).select({ count: count() }).from(product).where(where)
 * );
 * ```
 */
export async function executeListQueryWithCount<T>(
  dataQuery: Promise<T[]>,
  countQuery: Promise<{ count: number }[]>,
): Promise<{ data: T[]; count: number }> {
  const [data, [countResult]] = await Promise.all([dataQuery, countQuery]);
  return { data, count: countResult?.count ?? 0 };
}

/**
 * Build a partial update values object by filtering out undefined values.
 * This helper consolidates the pattern of conditionally building update objects
 * for database updates where only provided fields should be updated.
 *
 * @param data - Object containing potentially undefined values
 * @returns Object with only defined (non-undefined) key-value pairs
 *
 * @example
 * ```typescript
 * // Before
 * const updateValues: { name?: string; type?: string } = {};
 * if (data.name !== undefined) {
 *   updateValues.name = data.name;
 * }
 * if (data.type !== undefined) {
 *   updateValues.type = data.type;
 * }
 *
 * // After
 * const updateValues = buildPartialUpdateValues({
 *   name: data.name,
 *   type: data.type,
 * });
 * ```
 */
export function buildPartialUpdateValues<T extends Record<string, unknown>>(
  data: T,
): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  const result: Partial<{ [K in keyof T]: NonNullable<T[K]> }> = {};

  for (const key of Object.keys(data) as Array<keyof T>) {
    if (data[key] !== undefined) {
      result[key] = data[key] as NonNullable<T[typeof key]>;
    }
  }

  return result;
}

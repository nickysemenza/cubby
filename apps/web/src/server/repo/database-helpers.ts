import { ilike, type SQL, asc, desc } from "drizzle-orm";
import { type AnyColumn } from "drizzle-orm";
import { type SortParams } from "~/schemas/pagination";
import {
  type Database,
  type DrizzleClient,
  type DrizzleTransaction,
} from "~/server/db";

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
export const buildOrderBy = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  sort: SortParams,
  allowedFields: string[],
): SQL[] => {
  if (!allowedFields.includes(sort.orderBy)) {
    return [];
  }
  const column = table[sort.orderBy] as AnyColumn | undefined;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const insertAndReturn = async <T = any>(
  tx: DrizzleTransaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any,
): Promise<T> => {
  const result = await tx.insert(table).values(values).returning();
  const [created] = result as T[];
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const batchInsert = async <T = any>(
  tx: DrizzleTransaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any[],
): Promise<T[]> => {
  if (values.length === 0) return [];
  const result = await tx.insert(table).values(values).returning();
  return result as T[];
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const insertAndReturnDb = async <T = any>(
  db: Database,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any,
): Promise<T> => {
  const result = await getDb(db).insert(table).values(values).returning();
  const [created] = result as T[];
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateAndReturn = async <T = any>(
  tx: DrizzleTransaction,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: any,
): Promise<T> => {
  const result = await tx.update(table).set(values).where(where).returning();
  const [updated] = result as T[];
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const updateAndReturnDb = async <T = any>(
  db: Database,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  values: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: any,
): Promise<T> => {
  const result = await getDb(db)
    .update(table)
    .set(values)
    .where(where)
    .returning();
  const [updated] = result as T[];
  if (!updated) {
    throw new Error("Failed to update record");
  }
  return updated;
};

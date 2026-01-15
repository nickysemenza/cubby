/**
 * Data transformation helper functions.
 * Extract, map, and transform database records.
 */

import type { z } from "zod";

import { amount } from "~/codec/codec";
import { parseWithContext } from "~/lib/zod-utils";
import { unsafeProductId } from "~/schemas/identifiers";
import type { productUnitMappings } from "~/server/db/schema";

/**
 * Extract image records from join table results.
 * Common pattern: join tables have { image: typeof image.$inferSelect }
 * Automatically filters out soft-deleted join table records.
 */
export const extractImagesFromJoinTable = <
  T extends { image: { id: string }; deletedAt?: Date | null },
>(
  joinTableRecords: T[] | undefined | null,
): T["image"][] => {
  return (
    joinTableRecords
      ?.filter((record) => !record.deletedAt || record.deletedAt === null)
      .map((record) => record.image) ?? []
  );
};

/**
 * Map an array of DB records through a transformation function.
 * Handles null/undefined and returns empty array by default.
 * Automatically filters out soft-deleted records if they have a deletedAt field.
 */
export const mapRelation = <
  TIn extends { deletedAt?: Date | null } | Record<string, unknown>,
  TOut,
>(
  records: TIn[] | undefined | null,
  mapper: (record: TIn) => TOut,
): TOut[] => {
  if (!records) return [];

  // Filter out soft-deleted records if deletedAt field exists
  const filtered = records.filter((record) => {
    if ("deletedAt" in record) {
      return record.deletedAt === null;
    }
    return true;
  });

  return filtered.map(mapper);
};

/**
 * Add sourceMetadata to unit mappings for a product.
 * Injects { type: "product", productId } into each mapping's sourceMetadata field.
 * Automatically filters out soft-deleted unit mappings.
 */
export const addProductSourceMetadata = (
  productId: string,
  unitMappings: Array<typeof productUnitMappings.$inferSelect>,
) => {
  return unitMappings
    .filter((mapping) => mapping.deletedAt === null)
    .map((mapping) => ({
      ...mapping,
      sourceMetadata: {
        type: "product" as const,
        productId: unsafeProductId(productId),
      },
    }));
};

/**
 * Build a partial update values object by filtering out undefined values.
 * This helper consolidates the pattern of conditionally building update objects
 * for database updates where only provided fields should be updated.
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

/**
 * Parse an inventory entry's amount field with consistent error context.
 * Consolidates the repeated pattern of parsing amount JSON columns.
 */
export const parseInventoryAmount = (
  rawAmount: unknown,
  entryId: string,
): z.infer<typeof amount> => {
  return parseWithContext(amount, rawAmount, {
    entityType: "InventoryEntry",
    identifier: { id: entryId },
  });
};

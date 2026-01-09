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

/**
 * Parse an inventory entry's amount field with consistent error context.
 * Consolidates the repeated pattern of parsing amount JSON columns.
 *
 * @param rawAmount - The raw amount value from the database (JSON column)
 * @param entryId - The inventory entry ID for error context
 * @returns Parsed amount object
 *
 * @example
 * ```typescript
 * // Before
 * const parsedAmount = parseWithContext(amount, entry.amount, {
 *   entityType: "InventoryEntry",
 *   identifier: { id: entry.id },
 * });
 *
 * // After
 * const parsedAmount = parseInventoryAmount(entry.amount, entry.id);
 * ```
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

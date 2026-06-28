/**
 * Data transformation helper functions.
 * Extract, map, and transform database records.
 */

import { amount } from "@cubby/schemas/codec";
import type { ImageOut } from "@cubby/schemas/image";
import type { z } from "zod";
import { parseWithContext } from "~/lib/zod-utils";
import { isNotDeleted } from "./query";

/**
 * Extract image records from join table results.
 * Common pattern: join tables have { image: typeof image.$inferSelect }
 * Automatically filters out soft-deleted join table records.
 */
export const extractImagesFromJoinTable = <
  T extends {
    image: {
      id: string;
      url: string;
      key: string;
      filename: string;
      size: number;
      contentType: string;
      status: ImageOut["status"];
      createdAt: Date;
      updatedAt: Date;
      deletedAt?: Date | null;
    };
    deletedAt?: Date | null;
  },
>(
  joinTableRecords: T[] | undefined | null,
): ImageOut[] => {
  return (
    joinTableRecords
      ?.filter((record) => isNotDeleted(record) && isNotDeleted(record.image))
      .map((record) => ({
        id: record.image.id,
        url: record.image.url,
        key: record.image.key,
        filename: record.image.filename,
        size: record.image.size,
        contentType: record.image.contentType,
        status: record.image.status,
        createdAt: record.image.createdAt,
        updatedAt: record.image.updatedAt,
      })) ?? []
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

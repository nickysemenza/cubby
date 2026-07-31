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
 * A Drizzle `$inferSelect` row with `aliases` widened to optional — the shape a
 * relation-loaded row takes when `aliases` may be omitted by the query. Replaces
 * the hand-written `Omit<typeof X.$inferSelect, "aliases"> & { aliases?: string[] }`
 * repeated across the product/location/ingredient/inventory repos.
 */
export type RowWithOptionalAliases<T extends { aliases: string[] }> = Omit<
  T,
  "aliases"
> & { aliases?: string[] };

type ImageRecord = {
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

/**
 * Project image join rows to `ImageOut[]`, dropping soft-deleted rows (on both
 * the join row and the image itself). Accepts either the bare image record or
 * the `{ image }` join-table wrapper — the single image-mapping path shared by
 * every entity (product/location/recipe/inventory).
 */
export const mapImages = (
  rows:
    | Array<ImageRecord | { image: ImageRecord; deletedAt?: Date | null }>
    | undefined
    | null,
): ImageOut[] => {
  if (!rows) return [];
  return rows
    .flatMap((row) => {
      const dbImage = "image" in row ? row.image : row;
      return isNotDeleted(row) && isNotDeleted(dbImage) ? [dbImage] : [];
    })
    .map((dbImage) => ({
      id: dbImage.id,
      url: dbImage.url,
      key: dbImage.key,
      filename: dbImage.filename,
      size: dbImage.size,
      contentType: dbImage.contentType,
      status: dbImage.status,
      createdAt: dbImage.createdAt,
      updatedAt: dbImage.updatedAt,
    }));
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
 * Resolve a to-one joined parent's (e.g. task/expense → project) display
 * name, treating a soft-deleted parent as if it weren't joined at all. A
 * to-one relation can't carry a `where` (see relations.ts's doc comment on
 * to-many vs to-one), so this transform-layer check is the backstop — in
 * practice unreachable for task/expense since a live child always blocks its
 * parent project's deletion, but kept defensive.
 */
export const resolveLiveJoinName = (
  rel: { name: string; deletedAt: Date | null } | null | undefined,
): string | null => (rel && rel.deletedAt === null ? rel.name : null);

/**
 * The public-id counterpart of {@link resolveLiveJoinName}: a joined row's
 * shortcode, or null when the relation is absent or soft-deleted.
 *
 * Denormalized next to the name for the same reason the name is — a cross-link
 * needs both a label and a destination, and shortcodes are the destination now.
 */
export const resolveLiveJoinShortcode = (
  rel: { shortcode: string; deletedAt: Date | null } | null | undefined,
): string | null => (rel && rel.deletedAt === null ? rel.shortcode : null);

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

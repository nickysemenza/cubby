import { amount } from "@cubby/schemas/codec";
/**
 * Data transformation helper functions.
 * Extract, map, and transform database records.
 */
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type { z } from "zod";

import { parseWithContext } from "~/lib/zod-utils";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

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
> & {
  aliases?: string[];
};

/** Location-row compatibility shape while legacy fixtures omit the new tags column. */
export type RowWithOptionalAliasesAndTags<
  T extends { aliases: string[]; tags: string[] },
> = Omit<T, "aliases" | "tags"> & {
  aliases?: string[];
  tags?: string[];
};

export type MappableImageRecord = {
  /** The public `IMG-` code. `id` (the uuid) is deliberately NOT projected. */
  shortcode: string;
  key: string;
  filename: string;
  size: number;
  contentType: string;
  status: ImageOut["status"];
  width?: number | null;
  height?: number | null;
  detectedContentType?: string | null;
  sha256?: string | null;
  renderStatus?: ImageOut["renderStatus"] | null;
  storageStatus?: ImageOut["storageStatus"] | null;
  verifiedAt?: Date | null;
  source?: "own" | "catalog" | "unknown" | "screenshot" | null;
  sourcePageUrl?: string | null;
  sourceAssetUrl?: string | null;
  sourceName?: string | null;
  useOriginal?: boolean;
  capturedAt?: Date | null;
  capturedAtOffsetMinutes?: number | null;
  captureLocation?: {
    lat: number;
    lng: number;
    altitude?: number;
    horizontalAccuracy?: number;
  } | null;
  capturePlaceName?: string | null;
  captureDeviceLabel?: string | null;
  capturedByPartyId?: string | null;
  captureAttribution?: "none" | "derived" | "ambiguous" | "confirmed" | null;
  provenanceEvidence?: {
    basis:
      | "manual"
      | "sighting"
      | "import-url"
      | "exif"
      | "analysis"
      | "filename";
    ruleId?: string;
    detail?: string;
  } | null;
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
    | Array<
        | MappableImageRecord
        | { image: MappableImageRecord; deletedAt?: Date | null }
      >
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
      // The public code, never the uuid: `ImageOut.id` IS the shortcode, the
      // same way every other entity's API `id` is.
      id: parseShortcodeFor("image", dbImage.shortcode),
      url: getR2PublicUrl(dbImage.key),
      key: dbImage.key,
      filename: dbImage.filename,
      size: dbImage.size,
      contentType: dbImage.contentType,
      status: dbImage.status,
      // Relation fixtures and old narrow projections deliberately omit these
      // expand-only columns; API output represents those legacy values as null.
      width: dbImage.width ?? null,
      height: dbImage.height ?? null,
      detectedContentType: dbImage.detectedContentType ?? null,
      sha256: dbImage.sha256 ?? null,
      renderStatus: dbImage.renderStatus ?? null,
      storageStatus: dbImage.storageStatus ?? null,
      verifiedAt: dbImage.verifiedAt ?? null,
      source: dbImage.source ?? "unknown",
      sourcePageUrl: dbImage.sourcePageUrl ?? null,
      sourceAssetUrl: dbImage.sourceAssetUrl ?? null,
      sourceName: dbImage.sourceName ?? null,
      useOriginal: dbImage.useOriginal ?? false,
      capturedAt: dbImage.capturedAt ?? null,
      capturedAtOffsetMinutes: dbImage.capturedAtOffsetMinutes ?? null,
      captureLocation: dbImage.captureLocation ?? null,
      capturePlaceName: dbImage.capturePlaceName ?? null,
      captureDeviceLabel: dbImage.captureDeviceLabel ?? null,
      // Not resolved here: `dbImage.capturedByPartyId` (when present) is the
      // raw ledger-party uuid, not its public shortcode, and this generic
      // join-row mapper has no DB access to resolve either it or the live
      // party name. Callers that need them read from the dedicated Image
      // list/detail path (`repo/image.ts`), which does.
      capturedByPartyId: null,
      capturedByName: null,
      captureAttribution: dbImage.captureAttribution ?? "none",
      provenanceEvidence: dbImage.provenanceEvidence ?? null,
      createdAt: dbImage.createdAt,
      updatedAt: dbImage.updatedAt,
    }));
};

/**
 * Map an array of DB records through a transformation function.
 * Handles null/undefined and returns empty array by default.
 * Automatically filters out soft-deleted records if they have a deletedAt field.
 */
export const mapRelation = <TIn extends object, TOut>(
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
export function buildPartialUpdateValues<T extends object>(
  data: T,
): Partial<T> {
  const result: Partial<T> = {};

  for (const key in data) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (value !== undefined) result[key] = value;
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
  rawAmount: z.input<typeof amount>,
  entryId: string,
): z.infer<typeof amount> => {
  return parseWithContext(amount, rawAmount, {
    entityType: "InventoryEntry",
    identifier: { id: entryId },
  });
};

import {
  unsafeInventoryShortcode,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
/**
 * Location tree and hierarchy operations.
 * Build location trees, type counts, and import updates.
 */

import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  InventoryItemForTree,
} from "@cubby/schemas/location";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
  product,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  relations,
  unwrapDb,
} from "~/server/repo/database-helpers";

import { buildLocationWithChildren } from "./helpers";
import type { LocationWithParentChild } from "./internal-types";

export const buildLocationTree = async (db: Database) => {
  // Drizzle doesn't support recursive CTEs in the query builder,
  // so we'll use raw SQL for the recursive query
  // Excludes soft-deleted locations
  const res = await getDb(db).execute<LocationWithParentChild>(sql`
    WITH RECURSIVE location_tree AS (
      -- Base case: locations with no parent (excludes soft-deleted)
      SELECT
        l.*,
        0 as depth
      FROM ${location} l
      WHERE l."parentId" IS NULL AND l."deletedAt" IS NULL

      UNION ALL

      -- Recursive case: children of locations in the tree (excludes soft-deleted)
      SELECT
        l.*,
        lt.depth + 1 as depth
      FROM ${location} l
      INNER JOIN location_tree lt ON l."parentId" = lt.id
      WHERE lt.depth < 10 AND l."deletedAt" IS NULL
    )
    SELECT * FROM location_tree
    ORDER BY depth, name
  `);

  // Build the tree structure from flat results
  const locationsMap = new Map<string, LocationWithParentChild>();
  const rootLocations: LocationWithParentChild[] = [];

  // Cast raw SQL results to location type (safe because query selects from location table)
  const locationRows = res.rows as unknown as (typeof location.$inferSelect)[];

  // Batch fetch all images for all locations in one query to avoid N+1
  const locationIds = locationRows.map((loc) => loc.id);
  const allLocationImages =
    locationIds.length > 0
      ? await getDb(db).query.locationImage.findMany({
          where: inArray(locationImage.locationId, locationIds),
          ...relations.location.withImages.with.images,
        })
      : [];

  // Group images by locationId for efficient lookup
  const imagesByLocationId = new Map<
    string,
    Array<{ image: typeof image.$inferSelect }>
  >();
  for (const locImg of allLocationImages) {
    const existing = imagesByLocationId.get(locImg.locationId) ?? [];
    existing.push(locImg);
    imagesByLocationId.set(locImg.locationId, existing);
  }

  // Batch fetch inventory entries with product names for all locations (excludes soft-deleted)
  const allInventoryEntries =
    locationIds.length > 0
      ? await getDb(db)
          .select({
            id: inventoryEntry.id,
            shortcode: inventoryEntry.shortcode,
            locationId: inventoryEntry.locationId,
            amount: inventoryEntry.amount,
            productId: inventoryEntry.productId,
            productShortcode: product.shortcode,
            productName: product.name,
          })
          .from(inventoryEntry)
          .innerJoin(product, eq(inventoryEntry.productId, product.id))
          .where(
            and(
              inArray(inventoryEntry.locationId, locationIds),
              notDeleted(inventoryEntry),
            ),
          )
          .orderBy(product.name)
      : [];

  // Group inventory entries by locationId
  const inventoryByLocationId = new Map<string, InventoryItemForTree[]>();
  const countsByLocationId = new Map<string, number>();
  for (const entry of allInventoryEntries) {
    const existing = inventoryByLocationId.get(entry.locationId) ?? [];
    existing.push({
      id: unsafeInventoryShortcode(entry.shortcode),
      amount: entry.amount,
      productName: entry.productName,
      productId: unsafeProductShortcode(entry.productShortcode),
    });
    inventoryByLocationId.set(entry.locationId, existing);
    countsByLocationId.set(
      entry.locationId,
      (countsByLocationId.get(entry.locationId) ?? 0) + 1,
    );
  }

  // First pass: create all location objects with their images
  for (const loc of locationRows) {
    const locationWithRelations: LocationWithParentChild = {
      ...loc,
      // Convert string timestamps to Date objects
      createdAt:
        loc.createdAt instanceof Date
          ? loc.createdAt
          : new Date(loc.createdAt as string),
      updatedAt:
        loc.updatedAt instanceof Date
          ? loc.updatedAt
          : new Date(loc.updatedAt as string),
      deletedAt:
        loc.deletedAt instanceof Date
          ? loc.deletedAt
          : loc.deletedAt
            ? new Date(loc.deletedAt as string)
            : null,
      lastBulkInventory:
        loc.lastBulkInventory instanceof Date
          ? loc.lastBulkInventory
          : loc.lastBulkInventory
            ? new Date(loc.lastBulkInventory as string)
            : null,
      children: [],
      parent: null,
      images: imagesByLocationId.get(loc.id) ?? [],
      directItemCount: countsByLocationId.get(loc.id) ?? 0,
      inventoryItems: inventoryByLocationId.get(loc.id) ?? [],
    };
    locationsMap.set(loc.id, locationWithRelations);
  }

  // Second pass: build parent-child relationships
  for (const loc of locationRows) {
    const current = locationsMap.get(loc.id)!;

    if (loc.parentId) {
      const parent = locationsMap.get(loc.parentId);
      if (parent) {
        current.parent = parent;
        if (!parent.children) {
          parent.children = [];
        }
        parent.children.push(current);
      }
    } else {
      rootLocations.push(current);
    }
  }

  const tree: InfLocation[] = rootLocations.map((x) => {
    return buildLocationWithChildren(x, undefined, false);
  });
  return tree;
};

/**
 * Check if setting a new parent would create a circular reference
 *
 * Walks up the parent chain from the proposed parent to check if we'd
 * encounter the location being updated (which would create a cycle).
 *
 * @returns true if the change would create a cycle, false if safe
 */
export const wouldCreateParentCycle = async (
  db: Database | DrizzleTransaction,
  locationId: LocationId,
  newParentId: LocationId,
): Promise<boolean> => {
  // Can't be your own parent
  if (locationId === newParentId) {
    return true;
  }

  // Walk up the parent chain from the proposed parent
  let currentId: LocationId | null = newParentId;
  while (currentId) {
    if (currentId === locationId) {
      return true; // Found a cycle
    }
    const parentLocation: { parentId: LocationId | null } | undefined =
      await unwrapDb(db).query.location.findFirst({
        where: eq(location.id, currentId),
        columns: { parentId: true },
      });
    currentId = parentLocation?.parentId ?? null;
  }

  return false;
};

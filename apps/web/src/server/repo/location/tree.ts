/**
 * Location tree and hierarchy operations.
 * Build location trees, type counts, and import updates.
 */

import { count, desc, eq, inArray, sql } from "drizzle-orm";

import {
  type LocationId,
  unsafeInventoryId,
  unsafeProductId,
} from "~/schemas/identifiers";
import type { InfLocation, InventoryItemForTree } from "~/schemas/location";
import { locationType } from "~/schemas/location";
import { createAppError } from "~/server/api/trpc";
import type { Database } from "~/server/db";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
  product,
} from "~/server/db/schema";
import {
  buildPartialUpdateValues,
  getDb,
  relations,
} from "~/server/repo/database-helpers";

import { buildLocationWithChildren } from "./helpers";
import type {
  LocationImportData,
  LocationWithParentChild,
} from "./internal-types";

export const buildLocationTypeCount = async (db: Database) => {
  const types = await getDb(db)
    .select({
      type: location.type,
      count: count(),
    })
    .from(location)
    .groupBy(location.type)
    .orderBy(desc(count()));

  const present = Object.fromEntries(
    types.map((t) => [t.type, t.count] as const),
  ) as Record<string, number>;

  // Ensure all enum values are present with a default of 0
  const allKeys = (locationType.options ?? []) as readonly string[];
  const full = Object.fromEntries(
    allKeys.map((k) => [k, present[k] ?? 0] as const),
  );
  return full as Record<(typeof allKeys)[number], number>;
};

export const buildLocationTree = async (db: Database) => {
  // Drizzle doesn't support recursive CTEs in the query builder,
  // so we'll use raw SQL for the recursive query
  const res = await getDb(db).execute<LocationWithParentChild>(sql`
    WITH RECURSIVE location_tree AS (
      -- Base case: locations with no parent
      SELECT
        l.*,
        0 as depth
      FROM ${location} l
      WHERE l."parentId" IS NULL

      UNION ALL

      -- Recursive case: children of locations in the tree
      SELECT
        l.*,
        lt.depth + 1 as depth
      FROM ${location} l
      INNER JOIN location_tree lt ON l."parentId" = lt.id
      WHERE lt.depth < 10  -- Limit recursion depth
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

  // Batch fetch inventory entries with product names for all locations
  const allInventoryEntries =
    locationIds.length > 0
      ? await getDb(db)
          .select({
            id: inventoryEntry.id,
            locationId: inventoryEntry.locationId,
            amount: inventoryEntry.amount,
            productId: inventoryEntry.productId,
            productName: product.name,
          })
          .from(inventoryEntry)
          .innerJoin(product, eq(inventoryEntry.productId, product.id))
          .where(inArray(inventoryEntry.locationId, locationIds))
          .orderBy(product.name)
      : [];

  // Group inventory entries by locationId
  const inventoryByLocationId = new Map<string, InventoryItemForTree[]>();
  const countsByLocationId = new Map<string, number>();
  for (const entry of allInventoryEntries) {
    const existing = inventoryByLocationId.get(entry.locationId) ?? [];
    existing.push({
      id: unsafeInventoryId(entry.id),
      amount: entry.amount,
      productName: entry.productName,
      productId: unsafeProductId(entry.productId),
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
 * Update the lastBulkInventory timestamp for a location.
 * Used when completing manual inventory at a location (e.g., from Scanner page).
 */
export const touchLastBulkInventory = async (
  db: Database,
  id: LocationId,
): Promise<void> => {
  const result = await getDb(db)
    .update(location)
    .set({ lastBulkInventory: new Date() })
    .where(eq(location.id, id))
    .returning();

  if (result.length === 0) {
    throw createAppError("LOCATION_NOT_FOUND", `Location ${id} not found`);
  }
};

/**
 * Check if setting a new parent would create a circular reference
 *
 * Walks up the parent chain from the proposed parent to check if we'd
 * encounter the location being updated (which would create a cycle).
 *
 * @returns true if the change would create a cycle, false if safe
 */
const wouldCreateParentCycle = async (
  db: Database,
  locationId: LocationId,
  newParentId: LocationId,
): Promise<boolean> => {
  // Can't be your own parent
  if (locationId === newParentId) {
    return true;
  }

  // Walk up the parent chain from the proposed parent
  let currentId: string | null = newParentId;
  while (currentId) {
    if (currentId === locationId) {
      return true; // Found a cycle
    }
    const parentLocation: { parentId: string | null } | undefined = await getDb(
      db,
    ).query.location.findFirst({
      where: eq(location.id, currentId),
      columns: { parentId: true },
    });
    currentId = parentLocation?.parentId ?? null;
  }

  return false;
};

/**
 * Update location fields from CSV/sync import data
 * Used by importLocationsFromCSV when updating existing locations.
 * Returns true if any fields were updated.
 *
 * Handles all location sync fields:
 * - locationType: updates if provided and different
 * - parentId: updates if provided and different (with cycle detection)
 * - description: updates if provided
 * - lastInventoryDate: updates if provided
 */
export const updateLocationFromImport = async (
  db: Database,
  locationId: LocationId,
  data: LocationImportData,
): Promise<{ updated: boolean; cycleSkipped?: boolean }> => {
  // Check for parent cycle if parentId is being changed
  let cycleSkipped = false;
  let safeParentId = data.parentId;

  if (data.parentId !== undefined && data.parentId !== null) {
    const wouldCycle = await wouldCreateParentCycle(
      db,
      locationId,
      data.parentId,
    );
    if (wouldCycle) {
      // Skip parent update to prevent cycle, but continue with other updates
      safeParentId = undefined;
      cycleSkipped = true;
    }
  }

  const updateValues = buildPartialUpdateValues({
    lastBulkInventory: data.lastInventoryDate,
    description: data.description,
    type: data.locationType,
    parentId: safeParentId,
  });

  // Only update if there are values to update
  if (Object.keys(updateValues).length > 0) {
    await getDb(db)
      .update(location)
      .set(updateValues)
      .where(eq(location.id, locationId));
    return { updated: true, cycleSkipped };
  }
  return { updated: false, cycleSkipped };
};

/**
 * Location CRUD operations.
 * Core create, read, update, delete, list operations for locations.
 */

import type { ActorContext } from "@cubby/schemas/context";
import { type LocationId, unsafeLocationId } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationCreateInput,
  LocationUpdateInput,
} from "@cubby/schemas/location";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import { dedupe } from "~/misc/array-helpers";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  associatePendingImages,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  executeListQueryWithCount,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { generateUniqueLocationShortcode } from "~/server/repo/shortcode-utils";

import {
  buildLocationWithChildren,
  dbLocationToAPIWithChildren,
} from "./helpers";
import type {
  LocationFilters,
  LocationWithParentChild,
} from "./internal-types";
import { wouldCreateParentCycle } from "./tree";

// Create a new location
export const createLocation = async (
  db: Database,
  data: LocationCreateInput,
  actor: ActorContext,
) => {
  // Create the location
  // Explicitly handle empty string, undefined, and falsy values for parentId
  // Using undefined to completely omit the field from the insert when there's no parent
  // This ensures Drizzle sends SQL NULL rather than an empty string
  const parentIdValue =
    data.parentId && data.parentId.trim() !== "" ? data.parentId : undefined;

  // Generate unique shortcode with collision retry
  const shortcode = await generateUniqueLocationShortcode(db);

  const newLocation = await insertAndReturn(db, location, {
    name: data.name,
    type: data.type,
    shortcode,
    ...(parentIdValue !== undefined && { parentId: parentIdValue }),
  });

  // Associate images if provided
  if (data.pendingImageIds && data.pendingImageIds.length > 0) {
    await associatePendingImages(
      getDb(db),
      locationImage,
      "locationId",
      newLocation.id,
      data.pendingImageIds,
    );
  }

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "location",
    entityId: newLocation.id,
    action: "create",
  });

  return getLocationById(db, unsafeLocationId(newLocation.id));
};

// Update an existing location
export const updateLocation = async (
  db: Database,
  id: LocationId,
  data: LocationUpdateInput["data"],
  actor: ActorContext,
) => {
  // Check if the new parent would create a circular reference (includes self-parent check)
  if (data.parentId) {
    const wouldCycle = await wouldCreateParentCycle(db, id, data.parentId);
    if (wouldCycle) {
      throw createAppError(
        "LOCATION_CYCLE_DETECTED",
        "Cannot set parent: would create a circular reference",
      );
    }
  }

  // Fetch current state for audit logging
  const before = await getDb(db).query.location.findFirst({
    where: eq(location.id, id),
  });

  return await withTransaction(db, async (tx) => {
    // Build update values using helper to filter undefined
    const updateValues = buildPartialUpdateValues({
      name: data.name,
      type: data.type,
      parentId: data.parentId,
    });

    // Update the location (updateAndReturn handles empty values gracefully)
    const updated = await updateAndReturn(
      tx,
      location,
      updateValues,
      eq(location.id, id),
    );

    // Add new images using shared helper
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      await associatePendingImages(
        tx,
        locationImage,
        "locationId",
        updated.id,
        data.pendingImageIds,
      );
    }

    // Remove existing images
    if (data.removeImageIds && data.removeImageIds.length > 0) {
      await tx
        .delete(locationImage)
        .where(
          and(
            eq(locationImage.locationId, updated.id),
            inArray(locationImage.imageId, data.removeImageIds),
          ),
        );
    }

    // Log audit entry with changes
    if (before) {
      const changes = computeChanges(before, updated, [
        "name",
        "type",
        "parentId",
      ]);
      if (changes) {
        await logAuditEntry(tx, actor, {
          entityType: "location",
          entityId: id,
          action: "update",
          changes,
        });
      }
    }

    return getLocationById(tx, unsafeLocationId(updated.id));
  });
};

/**
 * Soft delete locations by setting deletedAt timestamp.
 * Also soft deletes related images.
 * Child locations are orphaned (parentId set to null) and become top-level locations.
 * Throws if any location has inventory.
 */
export const deleteLocations = async (
  db: Database,
  ids: LocationId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    // Lock locations and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, location, ids, "Location");

    // Safety check: don't delete if any location has inventory
    const withInventory = await tx.query.inventoryEntry.findMany({
      where: and(
        inArray(inventoryEntry.locationId, ids),
        notDeleted(inventoryEntry),
      ),
      columns: { locationId: true },
    });
    if (withInventory.length > 0) {
      const failedLocationIds = dedupe(withInventory.map((e) => e.locationId));
      const failedLocations = await tx.query.location.findMany({
        where: inArray(location.id, failedLocationIds),
        columns: { id: true, name: true },
      });
      const names = failedLocations.map((l) => l.name).join(", ");
      const count = failedLocations.length;
      throw createAppError(
        "LOCATION_HAS_INVENTORY",
        `Cannot delete ${count} location(s): ${names} have inventory entries. Move or remove them first.`,
      );
    }

    // Orphan any children by setting their parentId to null
    // This makes them top-level locations instead of blocking deletion
    await tx
      .update(location)
      .set({ parentId: null })
      .where(and(inArray(location.parentId, ids), notDeleted(location)));

    const now = new Date();

    // Get counts of cascaded items for audit trail
    const cascadedImages = await tx.query.locationImage.findMany({
      where: inArray(locationImage.locationId, ids),
      columns: { id: true, locationId: true },
    });

    // Group cascaded images by location ID for audit logging
    const imagesByLocation = new Map<string, number>();
    for (const img of cascadedImages) {
      imagesByLocation.set(
        img.locationId,
        (imagesByLocation.get(img.locationId) ?? 0) + 1,
      );
    }

    // Soft delete location images
    await tx
      .update(locationImage)
      .set({ deletedAt: now })
      .where(inArray(locationImage.locationId, ids));

    // Soft delete locations
    await tx
      .update(location)
      .set({ deletedAt: now })
      .where(inArray(location.id, ids));

    // Log audit entries with cascaded item counts (batch operation)
    const auditEntries = ids.map((id) => {
      const imageCount = imagesByLocation.get(id) ?? 0;

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (imageCount > 0) {
        changes.cascadedImages = { from: imageCount, to: 0 };
      }

      return {
        entityType: "location" as const,
        entityId: id,
        action: "delete" as const,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      };
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};

export const locationList = async (
  db: Database,
  filters: LocationFilters,
  sort: SortParams,
  pagination: PaginationParams,
  groupBy?: string,
) => {
  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    location,
    [{ column: location.name, term: filters.nameFilter }],
    [
      filters.itemTypeFilter
        ? eq(location.type, filters.itemTypeFilter)
        : undefined,
    ],
  );

  // Build order by using central sortableFields config
  const orderByClause = buildOrderBy(
    location,
    sort,
    [...getSortableFields("location")],
    groupBy,
  );

  const { take, skip } = buildTakeSkip(pagination);

  // Execute both queries in parallel using shared helper
  const { data: results, count: totalCount } = await executeListQueryWithCount(
    getDb(db).query.location.findMany({
      where: whereClause,
      ...relations.location.full,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    getDb(db).select({ count: count() }).from(location).where(whereClause),
  );

  const items = results.map(dbLocationToAPIWithChildren);
  return { data: items, count: totalCount };
};

// Update the AI description for a location
export const updateLocationAiDescription = async (
  db: Database,
  id: LocationId,
  aiDescription: string,
) => {
  await updateAndReturn(db, location, { aiDescription }, eq(location.id, id));
};

/**
 * Find locations that have images but no AI description.
 * Returns minimal data needed for backfill: id, name, and image URLs.
 */
export const findLocationsNeedingAiDescription = async (
  db: Database,
): Promise<Array<{ id: LocationId; name: string; imageUrls: string[] }>> => {
  const dbClient = getDb(db);

  // Find locations with images but no AI description
  const locations = await dbClient.query.location.findMany({
    where: and(notDeleted(location), isNull(location.aiDescription)),
    columns: { id: true, name: true },
    with: {
      images: {
        columns: {},
        with: {
          image: {
            columns: { url: true },
          },
        },
      },
    },
  });

  // Filter to only those that actually have images
  return locations
    .filter((loc) => loc.images.length > 0)
    .map((loc) => ({
      id: unsafeLocationId(loc.id),
      name: loc.name,
      imageUrls: loc.images.map((li) => li.image.url),
    }));
};

/**
 * Get all non-deleted location names.
 * Used by AI search to ground location name parsing against real data.
 */
export const getLocationNames = async (db: Database): Promise<string[]> => {
  const results = await getDb(db)
    .select({ name: location.name })
    .from(location)
    .where(notDeleted(location));
  return results.map((r) => r.name);
};

export const getLocationById = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
): Promise<InfLocation> => {
  // Fetch the location with parent chain and immediate children
  const res = await unwrapDb(db).query.location.findFirst({
    where: and(eq(location.id, id), notDeleted(location)),
    ...relations.location.full,
  });

  if (!res) {
    throw createAppError("LOCATION_NOT_FOUND", `Location ${id} not found`);
  }

  // Fetch parent chain recursively (up to 10 levels)
  let parentChain: LocationWithParentChild | null = null;
  if (res.parentId) {
    let currentParentId: string | null = res.parentId;
    let depth = 0;
    const parents: Array<
      typeof location.$inferSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
        }>;
      }
    > = [];

    while (currentParentId && depth < 10) {
      const parentData: (typeof parents)[number] | undefined = await unwrapDb(
        db,
      ).query.location.findFirst({
        where: eq(location.id, currentParentId),
        ...relations.location.withImages,
      });

      if (!parentData) break;

      parents.unshift(parentData);
      currentParentId = parentData.parentId;
      depth++;
    }

    // Build parent chain from root to immediate parent
    for (const parentData of parents) {
      const parentWithRelations: LocationWithParentChild = {
        ...parentData,
        children: [],
        parent: parentChain,
        images: parentData.images,
      };
      parentChain = parentWithRelations;
    }
  }

  // Enrich children with counts so the frontend doesn't need extra queries
  const activeChildren = (res.children ?? []).filter(
    (c) => c.id !== id && c.deletedAt === null,
  );
  const childIds = activeChildren.map((c) => c.id);

  const childCountMap: Record<string, number> = {};
  const inventoryCountMap: Record<string, number> = {};

  if (childIds.length > 0) {
    const dbClient = unwrapDb(db);

    // Run both count queries in parallel
    const [childCountResults, inventoryCountResults] = await Promise.all([
      dbClient
        .select({
          parentId: location.parentId,
          count: sql<number>`count(*)::int`,
        })
        .from(location)
        .where(and(notDeleted(location), inArray(location.parentId, childIds)))
        .groupBy(location.parentId),
      dbClient
        .select({
          locationId: inventoryEntry.locationId,
          count: sql<number>`count(*)::int`,
        })
        .from(inventoryEntry)
        .where(
          and(
            notDeleted(inventoryEntry),
            inArray(inventoryEntry.locationId, childIds),
          ),
        )
        .groupBy(inventoryEntry.locationId),
    ]);

    for (const row of childCountResults) {
      if (row.parentId) childCountMap[row.parentId] = row.count;
    }
    for (const row of inventoryCountResults) {
      inventoryCountMap[row.locationId] = row.count;
    }
  }

  // Attach counts to children
  const enrichedChildren: LocationWithParentChild[] = (res.children ?? []).map(
    (child) => ({
      ...child,
      childCount: childCountMap[child.id] ?? 0,
      directItemCount: inventoryCountMap[child.id] ?? 0,
    }),
  );

  const locationWithParent: LocationWithParentChild = {
    ...res,
    parent: parentChain,
    children: enrichedChildren,
    images: res.images,
  };

  return buildLocationWithChildren(locationWithParent, id);
};

/**
 * Get child location counts for multiple parent locations in a single query.
 * Returns a map of locationId -> count of direct children.
 */
export const getChildCountsByLocationIds = async (
  db: Database,
  locationIds: string[],
): Promise<Record<string, number>> => {
  if (locationIds.length === 0) return {};

  const dbClient = getDb(db);

  const results = await dbClient
    .select({
      parentId: location.parentId,
      count: sql<number>`count(*)::int`,
    })
    .from(location)
    .where(and(notDeleted(location), inArray(location.parentId, locationIds)))
    .groupBy(location.parentId);

  const countMap: Record<string, number> = {};
  for (const row of results) {
    if (row.parentId) {
      countMap[row.parentId] = row.count;
    }
  }

  return countMap;
};

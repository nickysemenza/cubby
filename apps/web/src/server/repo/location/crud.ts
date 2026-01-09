/**
 * Location CRUD operations.
 * Core create, read, update, delete, list operations for locations.
 */

import { and, count, eq, inArray } from "drizzle-orm";

import { getSortableFields } from "~/entities/entities";
import type { ActorContext } from "~/schemas/context";
import { type LocationId, unsafeLocationId } from "~/schemas/identifiers";
import type {
  InfLocation,
  LocationCreateInput,
  LocationUpdateInput,
} from "~/schemas/location";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import { createAppError } from "~/server/api/trpc";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
} from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  buildOrderBy,
  buildPartialUpdateValues,
  executeListQueryWithCount,
  getDb,
  insertAndReturnDb,
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

  const newLocation = await insertAndReturnDb(db, location, {
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
  // Make sure we're not setting a location as its own parent
  if (data.parentId === id) {
    throw new Error("A location cannot be its own parent");
  }

  // Check if the new parent would create a circular reference
  if (data.parentId) {
    const potentialParent = await getDb(db).query.location.findFirst({
      where: eq(location.id, data.parentId),
      with: { parent: true },
    });

    // Walk up the parent chain to check for circular references
    let currentParent = potentialParent?.parent;
    while (currentParent) {
      if (currentParent.id === id) {
        throw new Error("Circular parent-child relationship detected");
      }
      currentParent = await getDb(db)
        .query.location.findFirst({
          where: eq(location.id, currentParent.id),
          with: { parent: true },
        })
        .then((loc: typeof potentialParent) => loc?.parent ?? null);
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
 * Check if a location has any inventory entries (internal helper)
 */
const locationHasInventory = async (
  db: Database,
  locationId: LocationId,
): Promise<boolean> => {
  const result = await getDb(db)
    .select({ count: count() })
    .from(inventoryEntry)
    .where(eq(inventoryEntry.locationId, locationId));
  return (result[0]?.count ?? 0) > 0;
};

/**
 * Delete a location by ID
 * Returns true if deleted, false if not found
 * Throws if location has inventory (safety check)
 */
export const deleteLocation = async (
  db: Database,
  id: LocationId,
  actor: ActorContext,
): Promise<boolean> => {
  // Safety check: don't delete if location has inventory
  const hasInventory = await locationHasInventory(db, id);
  if (hasInventory) {
    throw createAppError(
      "LOCATION_HAS_INVENTORY",
      `Cannot delete location ${id}: it still has inventory items`,
    );
  }

  // Delete location images first (cascade doesn't handle this)
  await getDb(db).delete(locationImage).where(eq(locationImage.locationId, id));

  // Delete the location
  const result = await getDb(db)
    .delete(location)
    .where(eq(location.id, id))
    .returning();

  if (result.length > 0) {
    // Log audit entry
    await logAuditEntry(db, actor, {
      entityType: "location",
      entityId: id,
      action: "delete",
    });
    return true;
  }

  return false;
};

export const locationList = async (
  db: Database,
  filters: LocationFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters.nameFilter) {
    const { formatSearchTerm } = await import("~/server/repo/database-helpers");
    const nameCondition = formatSearchTerm(location.name, filters.nameFilter);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  if (filters.itemTypeFilter) {
    conditions.push(eq(location.type, filters.itemTypeFilter));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // Build order by using central sortableFields config
  const orderByClause = buildOrderBy(location, sort, [
    ...getSortableFields("location"),
  ]);

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

export const getLocationById = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
): Promise<InfLocation> => {
  // Fetch the location with parent chain and immediate children
  const res = await unwrapDb(db).query.location.findFirst({
    where: eq(location.id, id),
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

  const locationWithParent: LocationWithParentChild = {
    ...res,
    parent: parentChain,
    children: res.children,
    images: res.images,
  };

  return buildLocationWithChildren(locationWithParent, id);
};

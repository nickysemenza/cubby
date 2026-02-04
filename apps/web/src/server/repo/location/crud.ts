/**
 * Location CRUD operations.
 * Core create, read, update, delete, list operations for locations.
 */

import { and, count, eq, inArray } from "drizzle-orm";

import { getSortableFields } from "~/entities/entities";
import { dedupe } from "~/misc/array-helpers";
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

  const locationWithParent: LocationWithParentChild = {
    ...res,
    parent: parentChain,
    children: res.children,
    images: res.images,
  };

  return buildLocationWithChildren(locationWithParent, id);
};

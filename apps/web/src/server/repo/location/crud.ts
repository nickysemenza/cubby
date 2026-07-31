/**
 * Location CRUD operations.
 * Core create, read, update, delete, list operations for locations.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import type { LocationId } from "@cubby/schemas/identifiers";
import type {
  InfLocation,
  LocationCreateInput,
  LocationUpdateInput,
} from "@cubby/schemas/location";
import { locationSortableFields } from "@cubby/schemas/location";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { countBy } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  type image,
  inventoryEntry,
  location,
  locationImage,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  applyImageOrder,
  assertNoDependents,
  associatePendingImages,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  getDb,
  idSetPresence,
  insertAndReturn,
  lockAndValidateForDelete,
  nextImageSortOrder,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding";
import { generateUniqueLocationShortcode } from "~/server/repo/shortcode-utils";

import { buildLocationWithChildren, dbLocationToListAPI } from "./helpers";
import type {
  LocationFilters,
  LocationWithParentChild,
} from "./internal-types";
import { wouldCreateParentCycle } from "./tree";

export const LOCATION_DELETE_EDGE_POLICY = {
  "InventoryEntry.locationId": {
    code: "block-live-inventory",
    effect: "block",
    description:
      "A location still holding inventory can't be deleted — move or remove the inventory first.",
  },
  "LocationImage.locationId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the location; the underlying images are not.",
  },
  "Location.parentId": {
    code: "clear-live-child-parent",
    effect: "detach",
    description:
      "A deleted location's children are orphaned to the root — their parentId is cleared rather than the deletion being blocked.",
  },
} as const satisfies IncomingEdgePolicy<"location", OperationDisposition>;

// Verify a proposed parent location actually exists and isn't soft-deleted.
// Without this, a dangling parentId silently inserts: wouldCreateParentCycle
// walks off the end of a non-existent chain and reports "no cycle", orphaning
// the row in the tree.
const assertParentLocationExists = async (
  db: Database | DrizzleTransaction,
  parentId: LocationId,
): Promise<void> => {
  const parent = await unwrapDb(db).query.location.findFirst({
    where: and(eq(location.id, parentId), notDeleted(location)),
    columns: { id: true },
  });
  if (!parent) {
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      "Cannot set parent: the specified parent location does not exist",
    );
  }
};

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

  // Reject a parentId that doesn't reference a real, non-deleted location.
  if (parentIdValue !== undefined) {
    await assertParentLocationExists(db, parentIdValue);
  }

  // Generate unique shortcode with collision retry
  const shortcode = await generateUniqueLocationShortcode(db);

  const newLocation = await insertAndReturn(db, location, {
    name: data.name,
    aliases: data.aliases,
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

  return getLocationById(db, newLocation.id);
};

/**
 * Identifying predicate for the single global "Unknown" parking location — the
 * root-level bin a scan/import drops an item into when it has no home yet.
 * Exported so every consumer (ensure-or-create below, the Problems
 * "parked in Unknown" detector) agrees on what "Unknown" means.
 */
export const isGlobalUnknownLocation = () =>
  and(
    eq(location.name, "Unknown"),
    isNull(location.parentId),
    notDeleted(location),
  );

export const ensureGlobalUnknownLocation = async (
  db: Database,
  actor: ActorContext,
) => {
  const findUnknown = () =>
    getDb(db).query.location.findFirst({
      where: isGlobalUnknownLocation(),
      columns: { id: true },
    });

  const existing = await findUnknown();

  if (existing) {
    return getLocationById(db, existing.id);
  }

  try {
    return await createLocation(
      db,
      {
        name: "Unknown",
        aliases: [],
        type: "area",
        parentId: null,
      },
      actor,
    );
  } catch (error) {
    // Location_name_key prevents duplicate active names; if another request won
    // the create race, reuse that row instead of surfacing a transient conflict.
    const raced = await findUnknown();
    if (raced) return getLocationById(db, raced.id);
    throw error;
  }
};

// Update an existing location
export const updateLocation = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
  data: LocationUpdateInput["data"],
  actor: ActorContext,
) => {
  // Check if the new parent would create a circular reference (includes self-parent check)
  if (data.parentId) {
    // Reject a dangling parentId before the cycle walk (which would otherwise
    // treat a missing parent as a valid top-of-chain and accept it).
    await assertParentLocationExists(db, data.parentId);
    const wouldCycle = await wouldCreateParentCycle(db, id, data.parentId);
    if (wouldCycle) {
      throw createAppError(
        "LOCATION_CYCLE_DETECTED",
        "Cannot set parent: would create a circular reference",
      );
    }
  }

  // Fetch current state for audit logging
  const before = await unwrapDb(db).query.location.findFirst({
    where: and(eq(location.id, id), notDeleted(location)),
  });

  const runUpdate = async (tx: DrizzleTransaction) => {
    // Build update values using helper to filter undefined
    const updateValues = buildPartialUpdateValues({
      name: data.name,
      aliases: data.aliases,
      type: data.type,
      parentId: data.parentId,
    });

    // Update the location (updateAndReturn handles empty values gracefully)
    const updated = await updateLiveAndReturn(tx, location, updateValues, id);

    // Reorder existing images (first = cover) before appending new ones so
    // additions always land after the reordered set.
    if (data.imageOrder && data.imageOrder.length > 0) {
      await applyImageOrder(
        tx,
        locationImage,
        locationImage.locationId,
        updated.id,
        data.imageOrder,
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

    // Add new images using shared helper
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      const startSortOrder = await nextImageSortOrder(
        tx,
        locationImage,
        locationImage.locationId,
        updated.id,
      );
      await associatePendingImages(
        tx,
        locationImage,
        "locationId",
        updated.id,
        data.pendingImageIds,
        startSortOrder,
      );
    }

    // Log audit entry with changes
    if (before) {
      const changes = computeChanges(before, updated, [
        "name",
        "aliases",
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

    return getLocationById(tx, updated.id);
  };

  return "rollback" in db
    ? await runUpdate(db)
    : await withTransaction(db, runUpdate);
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
    await assertNoDependents({
      offendingParentIds: withInventory.map((e) => e.locationId),
      fetchNames: (failedIds) =>
        tx.query.location.findMany({
          where: inArray(location.id, failedIds),
          columns: { name: true },
        }),
      reason: "LOCATION_HAS_INVENTORY",
      message: (count, names) =>
        `Cannot delete ${count} location(s): ${names} have inventory entries. Move or remove them first.`,
    });

    // Orphan any children by setting their parentId to null
    // This makes them top-level locations instead of blocking deletion
    await tx
      .update(location)
      .set({ parentId: null })
      .where(and(inArray(location.parentId, ids), notDeleted(location)));

    const now = new Date();

    // Get counts of cascaded images (per location) for the audit trail.
    const cascadedImages = await tx.query.locationImage.findMany({
      where: and(
        inArray(locationImage.locationId, ids),
        notDeleted(locationImage),
      ),
      columns: { locationId: true },
    });

    // Soft delete location images
    await tx
      .update(locationImage)
      .set({ deletedAt: now })
      .where(
        and(inArray(locationImage.locationId, ids), notDeleted(locationImage)),
      );

    // Soft delete locations
    await tx
      .update(location)
      .set({ deletedAt: now })
      .where(and(inArray(location.id, ids), notDeleted(location)));

    // Cascade the search embedding so a direct repo delete (no mutation
    // side-effect) can't leave an orphaned entityEmbedding row.
    await softDeleteEntityEmbeddingsTx(tx, "location", ids);

    const auditEntries = buildCascadeAuditEntries("location", ids, {
      cascadedImages: countBy(cascadedImages, (i) => i.locationId),
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};

export const locationList = async (
  db: Database,
  filters: LocationFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
) => {
  // Uncorrelated subquery of location ids holding live inventory. Inner-joins
  // Product (notDeleted) because dbLocationToListAPI drops inventory entries
  // whose product is soft-deleted — without that join, a shelf holding only
  // deleted products would count as "has inventory" here but render empty on
  // the list, so an empty-shelf search would miss it.
  const locationIdsWithLiveInventory = getDb(db)
    .select({ locationId: inventoryEntry.locationId })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    .where(notDeleted(inventoryEntry));

  // Build where conditions - always filter out deleted items
  const whereClause = buildSearchConditions(
    location,
    [{ column: location.name, term: filters.nameFilter }],
    [
      eqAny(location.type, filters.itemTypeFilter),
      eqAnyOrPresence(
        location.parentId,
        filters.parentId,
        filters.parentPresenceFilter,
      ),
      idSetPresence(
        location.id,
        filters.inventoryPresenceFilter,
        locationIdsWithLiveInventory,
      ),
    ],
  );

  const orderByClause = buildOrderBy(
    location,
    sorts,
    [...locationSortableFields],
    {
      groupBy,
      // `valuation` is a persisted jsonb rollup; sort by direct value because
      // that is what the list cell renders in compact mode.
      resolve: (s) => {
        const dirSql =
          s.direction === "asc" ? "asc nulls last" : "desc nulls last";
        if (s.orderBy === "valuation")
          return [
            s.direction === "asc"
              ? sql`(${location.valuation}->>'directValuation')::numeric asc nulls last`
              : sql`(${location.valuation}->>'directValuation')::numeric desc nulls last`,
          ];
        // Joined parent name — a correlated subquery keeps this a relational
        // findMany. Soft-delete guarded, like the read path.
        if (s.orderBy === "parent")
          return [
            sql.raw(
              `(SELECT l."name" FROM "Location" l ` +
                `WHERE l."id" = "location"."parentId" AND l."deletedAt" IS NULL) ${dirSql}`,
            ),
          ];
        return null;
      },
    },
  );

  const { take, skip } = buildTakeSkip(pagination);

  // Execute both queries in parallel using shared helper
  const { data: results, count: totalCount } = await executeListQueryWithCount(
    getDb(db).query.location.findMany({
      where: whereClause,
      ...relations.location.list,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    countWhere(db, location, whereClause),
  );

  const items = results.map(dbLocationToListAPI);
  return { data: items, count: totalCount };
};

// Update the AI description for a location
export const updateLocationAiDescription = async (
  db: Database,
  id: LocationId,
  aiDescription: string | null,
) => {
  await updateLiveAndReturn(db, location, { aiDescription }, id);
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
      id: loc.id,
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
    let currentParentId: LocationId | null = res.parentId;
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
  locationIds: LocationId[],
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

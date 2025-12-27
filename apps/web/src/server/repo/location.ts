import type { Database, Transaction } from "~/server/db";
import {
  type LocationOutWithParentChildren,
  type LocationOut,
  type InfLocation,
  locationType,
  type LocationCreateInput,
  type LocationUpdateInput,
  type LocationType,
  type InventoryItemForTree,
} from "~/schemas/location";
import {
  type LocationId,
  type OrganizationId,
  unsafeLocationId,
  unsafeProductId,
  unsafeInventoryId,
} from "~/schemas/identifiers";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { extractDbTimestampsFromDBRec } from "~/schemas/common";
import {
  formatSearchTerm,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  updateAndReturn,
  extractImagesFromJoinTable,
  mapRelation,
  associatePendingImages,
  buildPartialUpdateValues,
  executeListQueryWithCount,
} from "~/server/repo/database-helpers";
import { createAppError } from "~/server/api/trpc";
import {
  location,
  locationImage,
  type image,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import { eq, and, sql, count, desc, inArray, ilike } from "drizzle-orm";
import { logAuditEntry, computeChanges } from "~/server/repo/audit-log";
import type { ActorContext } from "~/schemas/context";
import { parseWithContext } from "~/lib/zod-utils";

// Create a new location
export const createLocation = async (
  db: Database,
  data: LocationCreateInput,
  actor: ActorContext,
) => {
  const { organizationId } = actor;
  // Create the location
  const [newLocation] = await getDb(db)
    .insert(location)
    .values({
      organizationId: organizationId,
      name: data.name,
      type: data.type,
      parentId: data.parentId ?? null,
    })
    .returning();

  if (!newLocation) {
    throw new Error("Failed to create location");
  }

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

  return getLocationById(db, unsafeLocationId(newLocation.id), organizationId);
};

// Update an existing location
export const updateLocation = async (
  db: Database,
  id: LocationId,
  data: LocationUpdateInput["data"],
  actor: ActorContext,
) => {
  const { organizationId } = actor;
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
    where: and(
      eq(location.id, id),
      eq(location.organizationId, organizationId),
    ),
  });

  return await getDb(db).transaction(async (tx: Transaction) => {
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
      and(eq(location.id, id), eq(location.organizationId, organizationId)),
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

    return getLocationById(tx, unsafeLocationId(updated.id), organizationId);
  });
};

type LocationDeepDB = typeof location.$inferSelect & {
  parent: typeof location.$inferSelect | null;
  children: Array<typeof location.$inferSelect>;
  InventoryEntries: Array<
    typeof inventoryEntry.$inferSelect & {
      Product: typeof product.$inferSelect;
    }
  >;
  images: Array<{
    image: typeof image.$inferSelect;
  }>;
};

const dbLocationToAPIWithChildren = (
  locationData: LocationDeepDB,
): LocationOutWithParentChildren => {
  const { parent, children, InventoryEntries, ...restOfLocation } =
    locationData;

  return {
    ...dbLocationToAPI(restOfLocation),
    parent: parent ? dbLocationToAPI(parent) : null,
    children: mapRelation(children, dbLocationToAPI),
    inventoryEntries: mapRelation(InventoryEntries, (x) => {
      const { Product, ...rest } = x;
      return {
        id: unsafeInventoryId(rest.id),
        amount: rest.amount as { value: number; unit: string },
        createdAt: rest.createdAt,
        updatedAt: rest.updatedAt,
        product: {
          id: unsafeProductId(Product.id),
          name: Product.name,
          manufacturer: Product.manufacturer,
          category: Product.category,
          upc: Product.upc,
          ndb_number: Product.ndb_number,
          model: Product.model,
          expectedQuantity: Product.expectedQuantity,
          // Product images are not fetched in this query for performance reasons
          // If product images are needed, use a separate query or join
          images: [],
          createdAt: Product.createdAt,
          updatedAt: Product.updatedAt,
        },
      };
    }),
  };
};

const dbLocationToAPI = (
  locationData: typeof location.$inferSelect & {
    images?: Array<{ image: typeof image.$inferSelect }>;
  },
): LocationOut => {
  return {
    id: unsafeLocationId(locationData.id),
    lastBulkInventory: locationData.lastBulkInventory,
    name: locationData.name,
    type: parseWithContext(locationType, locationData.type, {
      entityType: "Location",
      identifier: { id: locationData.id, name: locationData.name },
    }),
    images: extractImagesFromJoinTable(locationData.images),
    ...extractDbTimestampsFromDBRec(locationData),
  };
};

// Helper type for recursive location queries
type LocationWithParentChild = typeof location.$inferSelect & {
  children?: LocationWithParentChild[];
  parent?: LocationWithParentChild | null;
  images?: Array<{
    image: typeof image.$inferSelect;
  }>;
  directItemCount?: number;
  inventoryItems?: InventoryItemForTree[];
};

const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId?: string,
  includeParent = true,
): InfLocation => {
  const children =
    x.children && x.children.length > 0
      ? x.children
          .filter((child) => child.id !== excludeId)
          .map((child) =>
            buildLocationWithChildren(child, excludeId, includeParent),
          )
      : [];

  const directItemCount = x.directItemCount ?? 0;
  const childrenTotalCount = children.reduce(
    (sum, child) => sum + (child.totalItemCount ?? 0),
    0,
  );

  return {
    name: x.name,
    id: unsafeLocationId(x.id),
    lastBulkInventory: x.lastBulkInventory,
    type: parseWithContext(locationType, x.type, {
      entityType: "Location",
      identifier: { id: x.id, name: x.name },
    }),
    images: extractImagesFromJoinTable(x.images),
    children,
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(x.parent, excludeId, includeParent)
        : undefined,
    directItemCount,
    totalItemCount: directItemCount + childrenTotalCount,
    inventoryItems: x.inventoryItems ?? [],
    ...extractDbTimestampsFromDBRec(x),
  };
};

export const buildLocationTypeCount = async (
  db: Database,
  organizationId: OrganizationId,
) => {
  const types = await getDb(db)
    .select({
      type: location.type,
      count: count(),
    })
    .from(location)
    .where(eq(location.organizationId, organizationId))
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

export const buildLocationTree = async (
  db: Database,
  organizationId: OrganizationId,
) => {
  // Drizzle doesn't support recursive CTEs in the query builder,
  // so we'll use raw SQL for the recursive query
  const res = await getDb(db).execute<LocationWithParentChild>(sql`
    WITH RECURSIVE location_tree AS (
      -- Base case: locations with no parent
      SELECT
        l.*,
        0 as depth
      FROM ${location} l
      WHERE l."organizationId" = ${organizationId}
        AND l."parentId" IS NULL

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

/** Filters for location list queries */
interface LocationFilters {
  nameFilter?: string;
  itemTypeFilter?: string;
}

export const locationList = async (
  db: Database,
  organizationId: OrganizationId,
  filters: LocationFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const conditions = [eq(location.organizationId, organizationId)];

  if (filters.nameFilter) {
    const nameCondition = formatSearchTerm(location.name, filters.nameFilter);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  if (filters.itemTypeFilter) {
    conditions.push(eq(location.type, filters.itemTypeFilter));
  }

  const whereClause = and(...conditions);

  // Build order by
  const orderByClause = buildOrderBy(location, sort, [
    "createdAt",
    "name",
    "type",
    "lastBulkInventory",
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

/**
 * Find a location by its unique name (case-insensitive)
 * Returns null if not found
 */
export const findLocationByName = async (
  db: Database,
  organizationId: OrganizationId,
  name: string,
): Promise<LocationId | null> => {
  const loc = await getDb(db).query.location.findFirst({
    where: and(
      eq(location.organizationId, organizationId),
      ilike(location.name, name),
    ),
  });
  return loc ? unsafeLocationId(loc.id) : null;
};

/**
 * Find or create a location by name with optional parent
 * If location exists, returns its ID (does not update type/parent)
 * If location doesn't exist, creates it with the given type and parent
 */
export const findOrCreateLocationByName = async (
  db: Database,
  organizationId: OrganizationId,
  name: string,
  parentId: LocationId | null,
  type: LocationType,
): Promise<{ locationId: LocationId; created: boolean }> => {
  // Check if location already exists
  const existingId = await findLocationByName(db, organizationId, name);
  if (existingId) {
    return { locationId: existingId, created: false };
  }

  // Create new location
  const result = await getDb(db)
    .insert(location)
    .values({
      organizationId,
      name,
      type,
      parentId,
    })
    .returning();

  if (!result[0]) {
    throw new Error("Failed to create location");
  }

  return { locationId: unsafeLocationId(result[0].id), created: true };
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
  const { organizationId } = actor;

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
    .where(
      and(eq(location.id, id), eq(location.organizationId, organizationId)),
    )
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

export const getLocationById = async (
  db: Database | Transaction,
  id: LocationId,
  organizationId: OrganizationId,
) => {
  // Fetch the location with parent chain and immediate children
  const res = await unwrapDb(db).query.location.findFirst({
    where: and(
      eq(location.id, id),
      eq(location.organizationId, organizationId),
    ),
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

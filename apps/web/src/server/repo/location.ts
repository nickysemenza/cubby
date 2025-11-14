import { type Database, type Transaction } from "~/server/db";
import {
  type LocationOutWithParentChildren,
  type LocationOut,
  type InfLocation,
  locationType,
  LocationCreateInput,
  LocationUpdateInput,
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
import { type InfLocationConfig } from "../../schemas/config";
import { findOrCreateProduct, findProductByName } from "./product";
import {
  formatSearchTerm,
  getDb,
  unwrapDb,
  relations,
  buildOrderBy,
  insertAndReturn,
  updateAndReturn,
} from "~/server/repo/database-helpers";
import {
  location,
  locationImage,
  image,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import { eq, and, sql, count, not, desc } from "drizzle-orm";

// Create a new location
export const createLocation = async (
  db: Database,
  data: LocationCreateInput,
  organizationId: OrganizationId,
) => {
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
    // Create LocationImage records in batch
    await getDb(db)
      .insert(locationImage)
      .values(
        data.pendingImageIds.map((imageId) => ({
          locationId: newLocation.id,
          imageId,
        })),
      );

    // Update all image statuses to UPLOADED in batch
    await getDb(db)
      .update(image)
      .set({ status: "UPLOADED" })
      .where(
        sql`${image.id} = ANY(ARRAY[${sql.join(
          data.pendingImageIds.map((id) => sql`${id}`),
          sql`, `,
        )}])`,
      );
  }

  return getLocationById(db, unsafeLocationId(newLocation.id), organizationId);
};

// Update an existing location
export const updateLocation = async (
  db: Database,
  id: LocationId,
  organizationId: OrganizationId,
  data: LocationUpdateInput["data"],
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

  return await getDb(db).transaction(async (tx: Transaction) => {
    // Build update values
    const updateValues: {
      name?: string;
      type?: string;
      parentId?: string | null;
    } = {};

    if (data.name !== undefined) {
      updateValues.name = data.name;
    }
    if (data.type !== undefined) {
      updateValues.type = data.type;
    }
    if (data.parentId !== undefined) {
      updateValues.parentId = data.parentId;
    }

    // Update the location
    const updated = await updateAndReturn(
      tx,
      location,
      updateValues,
      and(eq(location.id, id), eq(location.organizationId, organizationId)),
    );

    // Add new images
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      // Create LocationImage records in batch
      await tx.insert(locationImage).values(
        data.pendingImageIds.map((imageId) => ({
          locationId: updated.id,
          imageId,
        })),
      );

      // Update all image statuses to UPLOADED in batch
      await tx
        .update(image)
        .set({ status: "UPLOADED" })
        .where(
          sql`${image.id} = ANY(ARRAY[${sql.join(
            data.pendingImageIds.map((imgId) => sql`${imgId}`),
            sql`, `,
          )}])`,
        );
    }

    // Remove existing images
    if (data.removeImageIds && data.removeImageIds.length > 0) {
      await tx.delete(locationImage).where(
        and(
          eq(locationImage.locationId, updated.id),
          sql`${locationImage.imageId} = ANY(ARRAY[${sql.join(
            data.removeImageIds.map((imgId) => sql`${imgId}`),
            sql`, `,
          )}])`,
        ),
      );
    }

    return getLocationById(tx, unsafeLocationId(updated.id), organizationId);
  });
};

const upsertChild = async (
  db: Transaction,
  now: Date,
  parent: { id: string } | null,
  child: InfLocationConfig,
  organizationId: OrganizationId,
) => {
  // Try to find existing location
  const existing = await db.query.location.findFirst({
    where: and(
      eq(location.organizationId, organizationId),
      eq(location.name, child.name),
    ),
  });

  if (existing) {
    // Update existing
    return await updateAndReturn(
      db,
      location,
      {
        name: child.name,
        type: child.type,
        updatedAt: now,
        parentId: parent?.id ?? null,
      },
      eq(location.id, existing.id),
    );
  } else {
    // Create new
    return await insertAndReturn(db, location, {
      organizationId: organizationId,
      name: child.name,
      type: child.type,
      updatedAt: now,
      parentId: parent?.id ?? null,
    });
  }
};

export const loadLocations = async (
  db: Transaction,
  data: InfLocationConfig[],
  organizationId: OrganizationId,
) => {
  const now = new Date();
  const loadRecursive = async (
    parent: { id: string } | null,
    children: InfLocationConfig[],
  ): Promise<void> => {
    for (const child of children) {
      const res = await upsertChild(db, now, parent, child, organizationId);
      const productsAtLocation = [];
      for (const productConfig of child.products ?? []) {
        const productRow = await findOrCreateProduct(
          db,
          now,
          productConfig,
          organizationId,
        );
        productsAtLocation.push(productRow);
      }
      for (const productRef of child.productReferences ?? []) {
        const productRow = await findProductByName(db, productRef.name);
        productsAtLocation.push(productRow);
      }

      await db
        .delete(inventoryEntry)
        .where(eq(inventoryEntry.locationId, res.id));

      if (productsAtLocation.length > 0) {
        await db.insert(inventoryEntry).values(
          productsAtLocation.map((prod) => ({
            organizationId: organizationId,
            locationId: res.id,
            productId: prod.id,
            amount: { value: 1, unit: "each" },
          })),
        );
      }

      await loadRecursive(res, child.children ?? []);
    }
  };

  await loadRecursive(null, data);

  const stale = await db.query.location.findMany({
    where: and(
      eq(location.organizationId, organizationId),
      not(eq(location.updatedAt, now)),
    ),
  });

  for (const s of stale) {
    await db.delete(location).where(eq(location.id, s.id));
  }
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
  const { parent, children, InventoryEntries, images, ...restOfLocation } =
    locationData;

  // Extract images from the join table records if they exist
  const locationImages = images ? images.map((li) => li.image) : [];

  return {
    ...dbLocationToAPI(restOfLocation),
    parent: parent ? dbLocationToAPI(parent) : null,
    children: children.map(dbLocationToAPI),
    images: locationImages,
    inventoryEntries: InventoryEntries.map((x) => {
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
          upc: Product.upc,
          ndb_number: Product.ndb_number,
          model: Product.model,
          expectedQuantity: Product.expectedQuantity,
          images: [], // todo: fill in eventually
          createdAt: Product.createdAt,
          updatedAt: Product.updatedAt,
        },
      };
    }),
  };
};

const dbLocationToAPI: (
  locationData: typeof location.$inferSelect,
) => LocationOut = (locationData) => {
  return {
    id: unsafeLocationId(locationData.id),
    lastBulkInventory: locationData.lastBulkInventory,
    name: locationData.name,
    type: locationType.parse(locationData.type),
    images: [], //todo: fix
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
};

const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId?: string,
  includeParent = true,
): InfLocation => {
  // Extract images if they exist
  const locationImages = x.images ? x.images.map((li) => li.image) : [];

  return {
    name: x.name,
    id: x.id as unknown as LocationId,
    lastBulkInventory: x.lastBulkInventory,
    type: locationType.parse(x.type),
    images: locationImages,
    children:
      x.children && x.children.length > 0
        ? x.children
            .filter((child) => child.id !== excludeId)
            .map((child) =>
              buildLocationWithChildren(child, excludeId, includeParent),
            )
        : [],
    parent:
      includeParent && x.parent
        ? buildLocationWithChildren(x.parent, excludeId, includeParent)
        : undefined,
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

  // First pass: create all location objects
  for (const loc of res.rows as unknown as (typeof location.$inferSelect)[]) {
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
      images: [],
    };
    locationsMap.set(loc.id, locationWithRelations);
  }

  // Second pass: build parent-child relationships and fetch images
  for (const loc of res.rows as unknown as (typeof location.$inferSelect)[]) {
    const current = locationsMap.get(loc.id)!;

    // Fetch images for this location
    const locationImages = await getDb(db).query.locationImage.findMany({
      where: eq(locationImage.locationId, loc.id),
      ...relations.location.withImages.with.images,
    });
    current.images = locationImages;

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

export const locationList = async (
  db: Database,
  organizationId: OrganizationId,
  name: string | undefined,
  itemType: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const conditions = [eq(location.organizationId, organizationId)];

  if (name) {
    const nameCondition = formatSearchTerm(location.name, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  if (itemType) {
    conditions.push(eq(location.type, itemType));
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

  // Execute both queries
  const results = await getDb(db).query.location.findMany({
    where: whereClause,
    ...relations.location.full,
    orderBy: orderByClause,
    limit: take,
    offset: skip,
  });

  const [countResult] = await getDb(db)
    .select({ count: count() })
    .from(location)
    .where(whereClause);

  const totalCount = countResult?.count ?? 0;

  const items = results.map(dbLocationToAPIWithChildren);
  return { data: items, count: totalCount };
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
    throw new Error(`Location ${id} not found`);
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

import { type Database, type Transaction } from "~/server/db";
import {
  type LocationOutWithParentChildren,
  type LocationOut,
  type InfLocation,
  locationType,
  LocationCreateInput,
  LocationUpdateInput,
  type LocationType,
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
} from "~/server/repo/database-helpers";
import { notFoundError } from "~/lib/error-messages";
import {
  location,
  locationImage,
  image,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import { eq, and, sql, count, desc, inArray, ilike } from "drizzle-orm";
import { logAuditEntry, computeChanges } from "~/server/repo/audit-log";

// Type context for batch CSV imports with type inference
export interface LocationTypeContext {
  // Map of "full_path" (lowercase) -> type from CSV bracket notation
  pathTypes: Map<string, LocationType>;
  // Map of "name" (lowercase) -> type from existing database locations
  existingTypes: Map<string, LocationType>;
  // Detected conflicts: same path with different types in CSV
  conflicts: Array<{ path: string; types: LocationType[] }>;
}

// Create a new location
export const createLocation = async (
  db: Database,
  data: LocationCreateInput,
  organizationId: OrganizationId,
  userId: string,
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
    await associatePendingImages(
      getDb(db),
      locationImage,
      "locationId",
      newLocation.id,
      data.pendingImageIds,
    );
  }

  // Log audit entry
  await logAuditEntry(db, {
    organizationId,
    entityType: "location",
    entityId: newLocation.id,
    action: "create",
    userId,
  });

  return getLocationById(db, unsafeLocationId(newLocation.id), organizationId);
};

// Update an existing location
export const updateLocation = async (
  db: Database,
  id: LocationId,
  organizationId: OrganizationId,
  data: LocationUpdateInput["data"],
  userId: string,
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

    // Update the location
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
        await logAuditEntry(tx, {
          organizationId,
          entityType: "location",
          entityId: id,
          action: "update",
          changes,
          userId,
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
    type: locationType.parse(locationData.type),
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
};

const buildLocationWithChildren = (
  x: LocationWithParentChild,
  excludeId?: string,
  includeParent = true,
): InfLocation => {
  return {
    name: x.name,
    id: unsafeLocationId(x.id),
    lastBulkInventory: x.lastBulkInventory,
    type: locationType.parse(x.type),
    images: extractImagesFromJoinTable(x.images),
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

  // Execute both queries in parallel
  const [results, [countResult]] = await Promise.all([
    getDb(db).query.location.findMany({
      where: whereClause,
      ...relations.location.full,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    getDb(db).select({ count: count() }).from(location).where(whereClause),
  ]);

  const items = results.map(dbLocationToAPIWithChildren);
  return { data: items, count: countResult?.count ?? 0 };
};

// Build a location path string from a location with its parent chain
// Format: "Room > Shelf > Bin"
export const buildLocationPath = (
  locationData: {
    name: string;
    parent?: {
      name: string;
      parent?: { name: string; parent?: unknown } | null;
    } | null;
  },
  separator = " > ",
): string => {
  const parts: string[] = [];

  // Walk up the parent chain
  let current: typeof locationData | null | undefined = locationData;
  while (current) {
    parts.unshift(current.name);
    current = current.parent as typeof locationData | null | undefined;
  }

  return parts.join(separator);
};

/**
 * Parse a location path with optional embedded types
 * Supports both plain format ("garage > shelf") and typed format ("garage[room] > shelf[shelf]")
 *
 * @param path - Path string like "garage[room] > shelf[shelf]" or "garage > shelf"
 * @param separator - Path separator, defaults to " > "
 * @returns Array of {name, type} objects
 */
export const parseLocationPathWithTypes = (
  path: string,
  separator = " > ",
): Array<{ name: string; type: LocationType }> => {
  const parts = path.split(separator).map((p) => p.trim());

  return parts.map((part, index) => {
    // Match "name[type]" format
    const match = part.match(/^(.+?)\[([^\]]+)\]$/);
    if (match) {
      const name = match[1].trim();
      const typeStr = match[2].trim();
      // Validate the type
      const parsedType = locationType.safeParse(typeStr);
      if (parsedType.success) {
        return { name, type: parsedType.data };
      }
      // Invalid type - fall back to default
      console.warn(`Invalid location type "${typeStr}" in path, using default`);
    }
    // No bracket notation or invalid - use defaults: root = room, children = shelf
    return { name: part, type: index === 0 ? "room" : "shelf" };
  });
};

// Find a location by its path string (e.g., "Room > Shelf > Bin")
// Supports bracket notation: "Room[room] > Shelf[shelf]" - brackets are stripped for matching
// Returns null if not found
export const findLocationByPath = async (
  db: Database,
  organizationId: OrganizationId,
  path: string,
  separator = " > ",
): Promise<LocationId | null> => {
  const parts = path.split(separator).map((p) => {
    const trimmed = p.trim();
    // Strip bracket notation if present: "name[type]" -> "name"
    const match = trimmed.match(/^(.+?)\[([^\]]+)\]$/);
    return match ? match[1].trim() : trimmed;
  });

  if (parts.length === 0) {
    return null;
  }

  // Find each part in sequence, walking down the tree
  let currentParentId: string | null = null;

  for (const part of parts) {
    const conditions = [
      eq(location.organizationId, organizationId),
      ilike(location.name, part),
    ];

    if (currentParentId === null) {
      // Looking for root location (no parent)
      const rootLoc = await getDb(db).query.location.findFirst({
        where: and(...conditions, sql`${location.parentId} IS NULL`),
      });
      if (!rootLoc) {
        return null;
      }
      currentParentId = rootLoc.id;
    } else {
      // Looking for child of current parent
      const childLoc: typeof location.$inferSelect | undefined = await getDb(
        db,
      ).query.location.findFirst({
        where: and(...conditions, eq(location.parentId, currentParentId)),
      });
      if (!childLoc) {
        return null;
      }
      currentParentId = childLoc.id;
    }
  }

  return currentParentId ? unsafeLocationId(currentParentId) : null;
};

// Find or create a location by its path string
// Supports bracket notation for types: "garage[room] > shelf[shelf]"
// Creates intermediate locations as needed with parsed types or defaults (root=room, children=shelf)
export const findOrCreateLocationByPath = async (
  db: Database,
  organizationId: OrganizationId,
  path: string,
  separator = " > ",
): Promise<LocationId> => {
  const parsedParts = parseLocationPathWithTypes(path, separator);

  if (parsedParts.length === 0) {
    throw new Error("Invalid location path: empty path");
  }

  let currentParentId: string | null = null;

  for (const { name, type } of parsedParts) {
    const conditions = [
      eq(location.organizationId, organizationId),
      ilike(location.name, name),
    ];

    let existingLoc: typeof location.$inferSelect | undefined;

    if (currentParentId === null) {
      // Looking for root location (no parent)
      existingLoc = await getDb(db).query.location.findFirst({
        where: and(...conditions, sql`${location.parentId} IS NULL`),
      });
    } else {
      // Looking for child of current parent
      existingLoc = await getDb(db).query.location.findFirst({
        where: and(...conditions, eq(location.parentId, currentParentId)),
      });
    }

    if (existingLoc) {
      currentParentId = existingLoc.id;
    } else {
      // Create the location with the parsed type
      const result: Array<typeof location.$inferSelect> = await getDb(db)
        .insert(location)
        .values({
          organizationId: organizationId,
          name: name,
          type: type,
          parentId: currentParentId,
        })
        .returning();

      const newLoc = result[0];
      if (!newLoc) {
        throw new Error(`Failed to create location: ${name}`);
      }
      currentParentId = newLoc.id;
    }
  }

  return unsafeLocationId(currentParentId!);
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
    throw new Error(notFoundError("Location", id));
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

/**
 * Build a type context from CSV rows and existing database locations.
 * This enables type inference across the batch - types specified in any row
 * can be applied to bare paths in other rows.
 *
 * @param db - Database connection
 * @param organizationId - Organization to query
 * @param rows - CSV rows with optional location_path field
 * @param separator - Path separator, defaults to " > "
 * @returns LocationTypeContext with pathTypes, existingTypes, and any conflicts
 */
export const buildLocationTypeContext = async (
  db: Database,
  organizationId: OrganizationId,
  rows: Array<{ location_path?: string }>,
  separator = " > ",
): Promise<LocationTypeContext> => {
  const pathTypes: Map<string, LocationType> = new Map();
  const conflicts: Array<{ path: string; types: LocationType[] }> = [];

  // Pass 1: Extract types from bracket notation in all rows
  for (const row of rows) {
    if (!row.location_path) continue;

    const parts = row.location_path.split(separator).map((p) => p.trim());
    const pathSegments: string[] = [];

    for (const part of parts) {
      const match = part.match(/^(.+?)\[([^\]]+)\]$/);
      if (match) {
        const name = match[1].trim();
        const typeStr = match[2].trim();
        const parsedType = locationType.safeParse(typeStr);
        if (parsedType.success) {
          pathSegments.push(name.toLowerCase());
          const fullPath = pathSegments.join(separator);

          // Check for conflicts
          const existingType = pathTypes.get(fullPath);
          if (existingType && existingType !== parsedType.data) {
            // Find or add to conflicts array
            const existingConflict = conflicts.find((c) => c.path === fullPath);
            if (existingConflict) {
              if (!existingConflict.types.includes(parsedType.data)) {
                existingConflict.types.push(parsedType.data);
              }
            } else {
              conflicts.push({
                path: fullPath,
                types: [existingType, parsedType.data],
              });
            }
          } else {
            pathTypes.set(fullPath, parsedType.data);
          }
        } else {
          // Invalid type in bracket - just add name to path for tracking
          pathSegments.push(part.toLowerCase());
        }
      } else {
        // No bracket notation - just add to path segments
        pathSegments.push(part.toLowerCase());
      }
    }
  }

  // Pass 2: Query existing locations from database
  const existingLocations = await getDb(db).query.location.findMany({
    where: eq(location.organizationId, organizationId),
    columns: { name: true, type: true },
  });

  const existingTypes: Map<string, LocationType> = new Map();
  for (const loc of existingLocations) {
    const parsedType = locationType.safeParse(loc.type);
    if (parsedType.success) {
      existingTypes.set(loc.name.toLowerCase(), parsedType.data);
    }
  }

  // Pass 3: Check for conflicts between CSV types and existing database types
  // Since location names are unique per organization, we check by name
  for (const [csvPath, csvType] of pathTypes) {
    // Extract just the location name (last segment of the path)
    const pathParts = csvPath.split(separator);
    const locationName = pathParts[pathParts.length - 1];
    const dbType = existingTypes.get(locationName);

    if (dbType && dbType !== csvType) {
      // CSV specifies a different type than what exists in DB
      const existingConflict = conflicts.find(
        (c) => c.path === csvPath || c.path === locationName,
      );
      if (existingConflict) {
        if (!existingConflict.types.includes(dbType)) {
          existingConflict.types.push(dbType);
        }
      } else {
        conflicts.push({
          path: locationName,
          types: [dbType, csvType],
        });
      }
    }
  }

  return { pathTypes, existingTypes, conflicts };
};

/**
 * Parse a location path using type context for inference.
 * Type resolution priority:
 * 1. Explicit bracket notation in the current path
 * 2. Type from another row in the CSV (batch context)
 * 3. Type from existing database location
 * 4. Default (root=room, children=shelf)
 *
 * @param path - Path string like "garage > shelf" or "garage[room] > shelf[shelf]"
 * @param context - Type context from buildLocationTypeContext
 * @param separator - Path separator, defaults to " > "
 * @returns Array of {name, type} objects
 */
export const parseLocationPathWithContext = (
  path: string,
  context: LocationTypeContext,
  separator = " > ",
): Array<{ name: string; type: LocationType }> => {
  const parts = path.split(separator).map((p) => p.trim());
  const result: Array<{ name: string; type: LocationType }> = [];
  const pathSegments: string[] = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];

    // Check for explicit bracket notation first
    const match = part.match(/^(.+?)\[([^\]]+)\]$/);
    if (match) {
      const name = match[1].trim();
      const typeStr = match[2].trim();
      const parsedType = locationType.safeParse(typeStr);
      if (parsedType.success) {
        result.push({ name, type: parsedType.data });
        pathSegments.push(name.toLowerCase());
        continue;
      }
      // Invalid type - fall through to inference
    }

    // Extract name (strip brackets if present but type was invalid)
    const name = match ? match[1].trim() : part;
    pathSegments.push(name.toLowerCase());
    const fullPath = pathSegments.join(separator);

    // Priority 1: Type from CSV context (another row with explicit type)
    const csvType = context.pathTypes.get(fullPath);
    if (csvType) {
      result.push({ name, type: csvType });
      continue;
    }

    // Priority 2: Type from existing database location
    const dbType = context.existingTypes.get(name.toLowerCase());
    if (dbType) {
      result.push({ name, type: dbType });
      continue;
    }

    // Priority 3: Default (root=room, children=shelf)
    result.push({ name, type: index === 0 ? "room" : "shelf" });
  }

  return result;
};

/**
 * Find or create a location by its path string using type context for inference.
 * Creates intermediate locations as needed with inferred types.
 *
 * @param db - Database connection
 * @param organizationId - Organization to create in
 * @param path - Path string like "garage > shelf"
 * @param context - Type context from buildLocationTypeContext
 * @param separator - Path separator, defaults to " > "
 * @returns LocationId of the final (leaf) location
 */
export const findOrCreateLocationByPathWithContext = async (
  db: Database,
  organizationId: OrganizationId,
  path: string,
  context: LocationTypeContext,
  separator = " > ",
): Promise<LocationId> => {
  const parsedParts = parseLocationPathWithContext(path, context, separator);

  if (parsedParts.length === 0) {
    throw new Error("Invalid location path: empty path");
  }

  let currentParentId: string | null = null;

  for (const { name, type } of parsedParts) {
    const conditions = [
      eq(location.organizationId, organizationId),
      ilike(location.name, name),
    ];

    let existingLoc: typeof location.$inferSelect | undefined;

    if (currentParentId === null) {
      // Looking for root location (no parent)
      existingLoc = await getDb(db).query.location.findFirst({
        where: and(...conditions, sql`${location.parentId} IS NULL`),
      });
    } else {
      // Looking for child of current parent
      existingLoc = await getDb(db).query.location.findFirst({
        where: and(...conditions, eq(location.parentId, currentParentId)),
      });
    }

    if (existingLoc) {
      currentParentId = existingLoc.id;
    } else {
      // Create the location with the inferred type
      const result: Array<typeof location.$inferSelect> = await getDb(db)
        .insert(location)
        .values({
          organizationId: organizationId,
          name: name,
          type: type,
          parentId: currentParentId,
        })
        .returning();

      const newLoc = result[0];
      if (!newLoc) {
        throw new Error(`Failed to create location: ${name}`);
      }
      currentParentId = newLoc.id;
    }
  }

  return unsafeLocationId(currentParentId!);
};

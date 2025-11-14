import { type Database, type Transaction } from "~/server/db";
import { type z } from "zod";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import { type inventoryWithLocationAndProductOut } from "~/schemas/combo";
import { locationType } from "~/schemas/location";
import { amount } from "~/codec/codec";
import {
  withTransaction,
  getDb,
  buildOrderBy,
  insertAndReturnDb,
  insertAndReturn,
  relations,
  updateAndReturnDb,
  updateAndReturn,
  extractImagesFromJoinTable,
  addProductSourceMetadata,
} from "~/server/repo/database-helpers";
import { InventoryBulkOperationItem } from "~/schemas/inventory";
import {
  type InventoryId,
  type OrganizationId,
  type ProductId,
  type LocationId,
  unsafeInventoryId,
  unsafeProductId,
  unsafeLocationId,
} from "~/schemas/identifiers";
import {
  inventoryEntry,
  product,
  location,
  productUnitMappings,
  image,
} from "~/server/db/schema";
import { eq, and, count, not, ilike } from "drizzle-orm";

type InventoryEntryDeepDB = typeof inventoryEntry.$inferSelect & {
  Product: typeof product.$inferSelect & {
    unitMappings: Array<typeof productUnitMappings.$inferSelect>;
    images: Array<{
      image: typeof image.$inferSelect;
    }>;
  };
  location: typeof location.$inferSelect & {
    images: Array<{
      image: typeof image.$inferSelect;
    }>;
  };
};

const dbInventoryEntryToAPI: (
  inventoryentry: InventoryEntryDeepDB,
) => z.infer<typeof inventoryWithLocationAndProductOut> = (inventoryentry) => {
  const { Product, location, ...restOfInventoryEntry } = inventoryentry;
  const { type, images: locationImages, ...restOfLocation } = location;

  // Validate amount from JSON column
  const parsedAmount = amount.parse(restOfInventoryEntry.amount);

  return {
    ...restOfInventoryEntry,
    id: unsafeInventoryId(restOfInventoryEntry.id),
    amount: parsedAmount,
    location: {
      ...restOfLocation,
      id: unsafeLocationId(restOfLocation.id),
      type: locationType.parse(type),
      images: extractImagesFromJoinTable(locationImages),
    },
    product: {
      ...Product,
      id: unsafeProductId(Product.id),
      unitMappings: addProductSourceMetadata(Product.id, Product.unitMappings),
      images: extractImagesFromJoinTable(Product.images),
    },
  };
};

/**
 * Check if a product with expectedQuantity=1 already exists in a different location.
 * Returns null if no duplicate found, or an object with conflicting location details.
 */
export const checkUniqueProductDuplicate = async (
  db: Database,
  productId: ProductId,
  locationId: LocationId,
): Promise<{ productName: string; locationName: string } | null> => {
  // Check if this is a product with expectedQuantity=1 (unique item)
  const productData = await getDb(db).query.product.findFirst({
    where: eq(product.id, productId),
    columns: { expectedQuantity: true, name: true },
  });

  // If it's a unique item, check for duplicates
  if (productData?.expectedQuantity === 1) {
    const existingEntry = await getDb(db).query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.productId, productId),
        not(eq(inventoryEntry.locationId, locationId)),
      ),
      with: {
        location: {
          columns: { name: true },
        },
      },
    });

    if (existingEntry) {
      return {
        productName: productData.name,
        locationName: existingEntry.location.name,
      };
    }
  }

  return null;
};

export const getInventoryEntryByID = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
) => {
  const res = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    ...relations.inventory.full,
  });

  return res ? dbInventoryEntryToAPI(res) : null;
};

export const inventoryentryList = async (
  db: Database,
  sort: SortParams,
  pagination: PaginationParams,
  productNameFilter?: string,
  locationNameFilter?: string,
  locationIdFilter?: string,
) => {
  // Build order by array using helper
  const orderByArray = buildOrderBy(inventoryEntry, sort, [
    "createdAt",
    "amount",
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Build where conditions - note Drizzle doesn't support nested filters in relational queries
  // We'll need to do joins for filtering on related tables
  let whereClause = undefined;

  // For location ID filter, we can use a simple where clause
  if (locationIdFilter && !productNameFilter && !locationNameFilter) {
    whereClause = eq(inventoryEntry.locationId, locationIdFilter);
  }

  // If we have product or location name filters, we need to use query builder with joins
  if (productNameFilter || locationNameFilter) {
    const conditions = [];

    if (productNameFilter) {
      conditions.push(ilike(product.name, `%${productNameFilter}%`));
    }
    if (locationNameFilter) {
      conditions.push(ilike(location.name, `%${locationNameFilter}%`));
    }
    if (locationIdFilter) {
      conditions.push(eq(inventoryEntry.locationId, locationIdFilter));
    }

    const whereCondition =
      conditions.length > 1 ? and(...conditions) : conditions[0];

    // Use query builder for complex filtering
    const [results, [countResult]] = await Promise.all([
      getDb(db)
        .select({
          inventoryEntry: inventoryEntry,
          Product: product,
          location: location,
        })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(whereCondition)
        .orderBy(...orderByArray)
        .limit(take)
        .offset(skip),
      getDb(db)
        .select({ count: count() })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(whereCondition),
    ]);

    // Fetch full data with relations for each result
    const fullResults = await Promise.all(
      results.map(async (row) => {
        return await getDb(db).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, row.inventoryEntry.id),
          ...relations.inventory.full,
        });
      }),
    );

    const inventoryentrys = fullResults
      .filter((r) => r !== undefined)
      .map((r) => dbInventoryEntryToAPI(r));
    return { data: inventoryentrys, count: countResult?.count ?? 0 };
  }

  // Simple case: no complex filters
  const [results, [countResult]] = await Promise.all([
    getDb(db).query.inventoryEntry.findMany({
      where: whereClause,
      ...relations.inventory.full,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    getDb(db)
      .select({ count: count() })
      .from(inventoryEntry)
      .where(whereClause),
  ]);

  const inventoryentrys = results.map((r) => dbInventoryEntryToAPI(r));
  return { data: inventoryentrys, count: countResult?.count ?? 0 };
};

interface UpdateInventoryEntryData {
  amount?: z.infer<typeof import("~/codec/codec").amount>;
  productId?: ProductId;
  locationId?: LocationId;
}

export const updateInventoryEntry = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
  data: UpdateInventoryEntryData,
) => {
  const updateValues: {
    amount?: z.infer<typeof import("~/codec/codec").amount>;
    productId?: ProductId;
    locationId?: LocationId;
  } = {};

  if (data.amount) {
    updateValues.amount = data.amount;
  }
  if (data.productId) {
    updateValues.productId = data.productId;
  }
  if (data.locationId) {
    updateValues.locationId = data.locationId;
  }

  const updated = await updateAndReturnDb(
    db,
    inventoryEntry,
    updateValues,
    and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  );

  // Fetch with relations
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, updated.id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw new Error(`Inventory entry ${id} not found after update`);
  }

  return dbInventoryEntryToAPI(result);
};

interface CreateInventoryEntryData {
  amount: z.infer<typeof import("~/codec/codec").amount>;
  productId: ProductId;
  locationId: LocationId;
}

export const createInventoryEntry = async (
  db: Database,
  data: CreateInventoryEntryData,
  organizationId: OrganizationId,
) => {
  const created = await insertAndReturnDb(db, inventoryEntry, {
    organizationId: organizationId,
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
  });

  // Fetch with relations
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, created.id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw new Error("Failed to fetch created inventory entry");
  }

  return dbInventoryEntryToAPI(result);
};

export const bulkProcessInventoryEntries = async (
  db: Database,
  locationId: LocationId,
  items: InventoryBulkOperationItem[],
  organizationId: OrganizationId,
) => {
  // Use a transaction to ensure all operations are processed atomically
  const processedItems = await withTransaction(db, async (tx: Transaction) => {
    const results: InventoryEntryDeepDB[] = [];

    // First, get all existing inventory entries for this location
    const existingItems = await tx.query.inventoryEntry.findMany({
      where: eq(inventoryEntry.locationId, locationId),
      ...relations.inventory.full,
    });

    // Get IDs of items in the submitted array
    const submittedIds = items.filter((item) => item.id).map((item) => item.id);

    // Find items to delete (existing items not in the submitted array)
    const itemsToDelete = existingItems.filter(
      (item) => !submittedIds.includes(item.id),
    );

    // Delete items that are not in the submitted array
    for (const item of itemsToDelete) {
      await tx.delete(inventoryEntry).where(eq(inventoryEntry.id, item.id));
    }

    // Process submitted items - create new or update existing
    for (const item of items) {
      if (!item.id) {
        // Create new inventory entry - productId and amount are required
        if (!item.productId || !item.amount) {
          throw new Error("productId and amount are required for new items");
        }
        const created = await insertAndReturn(tx, inventoryEntry, {
          organizationId: organizationId,
          productId: item.productId,
          locationId: locationId,
          amount: item.amount,
        });

        // Fetch with relations
        const fullCreated = await tx.query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, created.id),
          ...relations.inventory.full,
        });

        if (fullCreated) {
          results.push(fullCreated);
        }
      } else {
        // Update existing inventory entry
        const updateValues: {
          amount?: z.infer<typeof import("~/codec/codec").amount>;
          productId?: ProductId;
        } = {};

        if (item.amount) {
          updateValues.amount = item.amount;
        }
        if (item.productId) {
          updateValues.productId = item.productId;
        }

        // Only process if there are actual updates
        if (Object.keys(updateValues).length > 0) {
          const updated = await updateAndReturn(
            tx,
            inventoryEntry,
            updateValues,
            eq(inventoryEntry.id, item.id),
          );

          // Fetch with relations
          const fullUpdated = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, updated.id),
            ...relations.inventory.full,
          });

          if (fullUpdated) {
            results.push(fullUpdated);
          }
        } else {
          // If no updates, just fetch the current item
          const current = await tx.query.inventoryEntry.findFirst({
            where: eq(inventoryEntry.id, item.id),
            ...relations.inventory.full,
          });

          if (current) {
            results.push(current);
          }
        }
      }
    }

    // Update the location's lastBulkInventory timestamp
    await tx
      .update(location)
      .set({ lastBulkInventory: new Date() })
      .where(eq(location.id, locationId));

    return results;
  });

  return processedItems.map(dbInventoryEntryToAPI);
};

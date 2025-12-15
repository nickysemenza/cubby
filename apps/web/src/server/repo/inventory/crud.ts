import { type Database, type Transaction } from "~/server/db";
import {
  type SortParams,
  type PaginationParams,
  buildTakeSkip,
} from "~/schemas/pagination";
import {
  getDb,
  buildOrderBy,
  insertAndReturnDb,
  relations,
  updateAndReturnDb,
  buildPartialUpdateValues,
} from "~/server/repo/database-helpers";
import { notFoundError } from "~/lib/error-messages";
import {
  type InventoryId,
  type OrganizationId,
  type ProductId,
  type LocationId,
} from "~/schemas/identifiers";
import { inventoryEntry, product, location } from "~/server/db/schema";
import { eq, and, count, not, ilike } from "drizzle-orm";
import { dbInventoryEntryToAPI } from "./helpers";
import {
  type UpdateInventoryEntryData,
  type CreateInventoryEntryData,
} from "./types";

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
  organizationId: OrganizationId,
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
  // Always include organization filter for security
  const baseCondition = eq(inventoryEntry.organizationId, organizationId);

  // For location ID filter, we can use a simple where clause
  let whereClause: ReturnType<typeof and> | ReturnType<typeof eq> =
    baseCondition;
  if (locationIdFilter && !productNameFilter && !locationNameFilter) {
    whereClause = and(
      baseCondition,
      eq(inventoryEntry.locationId, locationIdFilter),
    );
  }

  // If we have product or location name filters, we need to use query builder with joins
  if (productNameFilter || locationNameFilter) {
    // Always include organization filter for security
    const conditions = [eq(inventoryEntry.organizationId, organizationId)];

    if (productNameFilter) {
      conditions.push(ilike(product.name, `%${productNameFilter}%`));
    }
    if (locationNameFilter) {
      conditions.push(ilike(location.name, `%${locationNameFilter}%`));
    }
    if (locationIdFilter) {
      conditions.push(eq(inventoryEntry.locationId, locationIdFilter));
    }

    const whereCondition = and(...conditions);

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

    const inventoryEntries = fullResults
      .filter((r) => r !== undefined)
      .map((r) => dbInventoryEntryToAPI(r));
    return { data: inventoryEntries, count: countResult?.count ?? 0 };
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

  const inventoryEntries = results.map((r) => dbInventoryEntryToAPI(r));
  return { data: inventoryEntries, count: countResult?.count ?? 0 };
};

export const updateInventoryEntry = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
  data: UpdateInventoryEntryData,
) => {
  // Build update values using helper to filter undefined
  const updateValues = buildPartialUpdateValues({
    amount: data.amount,
    productId: data.productId,
    locationId: data.locationId,
  });

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
    throw new Error(notFoundError("Inventory entry", id) + " after update");
  }

  return dbInventoryEntryToAPI(result);
};

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

/**
 * Find inventory entry by product and location
 */
export const findInventoryByProductAndLocation = async (
  db: Database | Transaction,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
) => {
  const dbClient = "query" in db ? db : getDb(db as Database);
  return await dbClient.query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    ...relations.inventory.full,
  });
};

/**
 * Delete an inventory entry by ID
 */
export const deleteInventoryEntry = async (
  db: Database,
  id: InventoryId,
  organizationId: OrganizationId,
): Promise<void> => {
  await getDb(db)
    .delete(inventoryEntry)
    .where(
      and(
        eq(inventoryEntry.id, id),
        eq(inventoryEntry.organizationId, organizationId),
      ),
    );
};

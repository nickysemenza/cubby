import { type Database } from "~/server/db";
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
import { createAppError } from "~/server/api/trpc";
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
import { logAuditEntry, computeChanges } from "~/server/repo/audit-log";
import { type ActorContext } from "~/schemas/context";

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

/** Filters for inventory list queries */
interface InventoryFilters {
  productNameFilter?: string;
  locationNameFilter?: string;
  locationIdFilter?: string;
}

export const inventoryentryList = async (
  db: Database,
  organizationId: OrganizationId,
  filters: InventoryFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const orderByArray = buildOrderBy(inventoryEntry, sort, [
    "createdAt",
    "amount",
  ]);
  const { take, skip } = buildTakeSkip(pagination);

  // Determine if we need joins (name filters require joining related tables)
  const needsJoins = filters.productNameFilter || filters.locationNameFilter;

  if (needsJoins) {
    // Build conditions for join-based query
    const conditions = [eq(inventoryEntry.organizationId, organizationId)];
    if (filters.productNameFilter) {
      conditions.push(ilike(product.name, `%${filters.productNameFilter}%`));
    }
    if (filters.locationNameFilter) {
      conditions.push(ilike(location.name, `%${filters.locationNameFilter}%`));
    }
    if (filters.locationIdFilter) {
      conditions.push(eq(inventoryEntry.locationId, filters.locationIdFilter));
    }
    const whereCondition = and(...conditions);

    // Query with joins for name filtering
    const [results, [countResult]] = await Promise.all([
      getDb(db)
        .select({ inventoryEntry })
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
      results.map((row) =>
        getDb(db).query.inventoryEntry.findFirst({
          where: eq(inventoryEntry.id, row.inventoryEntry.id),
          ...relations.inventory.full,
        }),
      ),
    );

    const inventoryEntries = fullResults
      .filter((r) => r !== undefined)
      .map((r) => dbInventoryEntryToAPI(r));
    return { data: inventoryEntries, count: countResult?.count ?? 0 };
  }

  // Simple path: no name filters, use relational query
  const conditions = [eq(inventoryEntry.organizationId, organizationId)];
  if (filters.locationIdFilter) {
    conditions.push(eq(inventoryEntry.locationId, filters.locationIdFilter));
  }
  const whereClause =
    conditions.length === 1 ? conditions[0] : and(...conditions);

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
  data: UpdateInventoryEntryData,
  actor: ActorContext,
) => {
  const { organizationId } = actor;

  // Fetch current state for audit logging
  const before = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

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

  // Log audit entry with changes
  if (before) {
    const changes = computeChanges(before, updated, [
      "amount",
      "productId",
      "locationId",
    ]);
    if (changes) {
      await logAuditEntry(db, actor, {
        entityType: "inventory",
        entityId: id,
        action: "update",
        changes,
      });
    }
  }

  // Fetch with relations
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, updated.id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw createAppError(
      "INVENTORY_NOT_FOUND",
      `Inventory entry ${id} not found after update`,
    );
  }

  return dbInventoryEntryToAPI(result);
};

export const createInventoryEntry = async (
  db: Database,
  data: CreateInventoryEntryData,
  actor: ActorContext,
) => {
  const { organizationId } = actor;

  const created = await insertAndReturnDb(db, inventoryEntry, {
    organizationId: organizationId,
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
  });

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "inventory",
    entityId: created.id,
    action: "create",
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
 * Delete an inventory entry by ID
 */
export const deleteInventoryEntry = async (
  db: Database,
  id: InventoryId,
  actor: ActorContext,
): Promise<void> => {
  const { organizationId } = actor;

  await getDb(db)
    .delete(inventoryEntry)
    .where(
      and(
        eq(inventoryEntry.id, id),
        eq(inventoryEntry.organizationId, organizationId),
      ),
    );

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "inventory",
    entityId: id,
    action: "delete",
  });
};

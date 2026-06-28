import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, count, eq, inArray, not, sql } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import { computeInventoryValuation } from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  batchUpdateWithCaseWhen,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { assertLiveTargets } from "./helpers";
import { dbInventoryEntryToAPI, dbInventoryEntryToListAPI } from "./mappers";
import type {
  CreateInventoryEntryData,
  UpdateInventoryEntryData,
} from "./types";

/**
 * Compute valuation for an inventory entry based on amount and product price.
 * Returns the valuation value to store.
 * Accepts both Database and DrizzleTransaction for use within transactions.
 */
const computeValuationForEntry = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
  amountValue: number,
): Promise<number | null> => {
  const client = unwrapDb(db);
  const productData = await client.query.product.findFirst({
    where: eq(product.id, productId),
    columns: { price: true },
  });
  return computeInventoryValuation(amountValue, productData?.price ?? null);
};

/**
 * Sync valuation for all inventory entries of a specific product.
 * Called when product price changes.
 * Accepts both Database and DrizzleTransaction for use within transactions.
 */
export const syncInventoryValuationsForProduct = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
): Promise<number> => {
  const client = unwrapDb(db);

  // Get the product's current price
  const productData = await client.query.product.findFirst({
    where: eq(product.id, productId),
    columns: { price: true },
  });
  const productPrice = productData?.price ?? null;

  // Get all non-deleted inventory entries for this product
  const entries = await client.query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true, amount: true },
  });

  if (entries.length === 0) return 0;

  // Compute valuations in memory
  const updates = entries.map((entry) => {
    const amountValue =
      typeof entry.amount === "object" && entry.amount !== null
        ? (entry.amount as { value: number }).value
        : 0;
    const valuation = computeInventoryValuation(amountValue, productPrice);

    return { id: entry.id, valuation };
  });

  // Batch update all entries (1-4 queries instead of 1000+)
  const updated = await batchUpdateWithCaseWhen(
    client,
    inventoryEntry,
    updates,
  );

  return updated;
};

/**
 * How many active inventory entries a product has — equals how many valuations
 * `syncInventoryValuationsForProduct` resynced on a price change. Used by the
 * product update proc to report `inventoryValuationsUpdated` in its side-effects.
 */
export const countActiveInventoryForProduct = async (
  db: Database,
  productId: ProductId,
): Promise<number> =>
  countWhere(
    db,
    inventoryEntry,
    and(eq(inventoryEntry.productId, productId), notDeleted(inventoryEntry)),
  );

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

  // If it's a unique item, check for duplicates (excluding soft-deleted entries)
  if (productData?.expectedQuantity === 1) {
    const existingEntry = await getDb(db).query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.productId, productId),
        not(eq(inventoryEntry.locationId, locationId)),
        notDeleted(inventoryEntry),
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

export const getInventoryEntryByID = async (db: Database, id: InventoryId) => {
  const res = await getDb(db).query.inventoryEntry.findFirst({
    where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
    ...relations.inventory.full,
  });

  return res ? dbInventoryEntryToAPI(res) : null;
};

/** Filters for inventory list queries */
interface InventoryFilters {
  productNameFilter?: string;
  locationNameFilter?: string;
  locationIdFilter?: LocationId;
}

/**
 * Get inventory counts for multiple locations in a single query.
 * Returns a map of locationId -> count.
 */
export const getInventoryCountsByLocations = async (
  db: Database,
  locationIds: LocationId[],
): Promise<Record<string, number>> => {
  if (locationIds.length === 0) return {};

  const dbClient = getDb(db);

  // Query to get counts grouped by location
  const results = await dbClient
    .select({
      locationId: inventoryEntry.locationId,
      count: sql<number>`count(*)::int`,
    })
    .from(inventoryEntry)
    .where(
      and(
        notDeleted(inventoryEntry),
        inArray(inventoryEntry.locationId, locationIds),
      ),
    )
    .groupBy(inventoryEntry.locationId);

  // Convert to map
  const countMap: Record<string, number> = {};
  for (const row of results) {
    countMap[row.locationId] = row.count;
  }

  // Fill in zeros for locations with no inventory
  for (const locationId of locationIds) {
    if (!(locationId in countMap)) {
      countMap[locationId] = 0;
    }
  }

  return countMap;
};

export const inventoryentryList = async (
  db: Database,
  filters: InventoryFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  // Build order by using central sortableFields config
  const orderByArray = buildOrderBy(inventoryEntry, sort, [
    ...getSortableFields("inventory"),
  ]);
  const { take, skip } = buildTakeSkip(pagination);

  // Determine if we need joins (name filters require joining related tables)
  const needsJoins = filters.productNameFilter || filters.locationNameFilter;

  if (needsJoins) {
    // Build conditions for join-based query
    const whereCondition = buildSearchConditions(
      inventoryEntry,
      [
        { column: product.name, term: filters.productNameFilter },
        { column: location.name, term: filters.locationNameFilter },
      ],
      [
        filters.locationIdFilter
          ? eq(inventoryEntry.locationId, filters.locationIdFilter)
          : undefined,
      ],
    );

    // Query with joins for name filtering
    const [results, [countResult]] = await Promise.all([
      getDb(db)
        .select({ inventoryEntry })
        .from(inventoryEntry)
        .innerJoin(
          product,
          and(eq(inventoryEntry.productId, product.id), notDeleted(product)),
        )
        .innerJoin(
          location,
          and(eq(inventoryEntry.locationId, location.id), notDeleted(location)),
        )
        .where(whereCondition)
        .orderBy(...orderByArray)
        .limit(take)
        .offset(skip),
      getDb(db)
        .select({ count: count() })
        .from(inventoryEntry)
        .innerJoin(
          product,
          and(eq(inventoryEntry.productId, product.id), notDeleted(product)),
        )
        .innerJoin(
          location,
          and(eq(inventoryEntry.locationId, location.id), notDeleted(location)),
        )
        .where(whereCondition),
    ]);

    // Fetch row-display data with relations in a single batched query (avoids N+1)
    const ids = results.map((row) => row.inventoryEntry.id);
    const listResults =
      ids.length > 0
        ? await getDb(db).query.inventoryEntry.findMany({
            where: inArray(inventoryEntry.id, ids),
            ...relations.inventory.list,
          })
        : [];

    // Preserve original order from the filtered query
    const resultsById = new Map(listResults.map((r) => [r.id, r]));
    const inventoryEntries = ids
      .map((id) => resultsById.get(id))
      .filter((r) => r !== undefined)
      .map((r) => dbInventoryEntryToListAPI(r));
    return { data: inventoryEntries, count: countResult?.count ?? 0 };
  }

  // Simple path: no name filters, use relational query
  const whereClause = filters.locationIdFilter
    ? and(
        eq(inventoryEntry.locationId, filters.locationIdFilter),
        notDeleted(inventoryEntry),
      )
    : notDeleted(inventoryEntry);

  const [results, totalCount] = await Promise.all([
    getDb(db).query.inventoryEntry.findMany({
      where: whereClause,
      ...relations.inventory.list,
      orderBy: orderByArray,
      limit: take,
      offset: skip,
    }),
    countWhere(db, inventoryEntry, whereClause),
  ]);

  const inventoryEntries = results.map((r) => dbInventoryEntryToListAPI(r));
  return { data: inventoryEntries, count: totalCount };
};

export const updateInventoryEntry = async (
  db: Database,
  id: InventoryId,
  data: UpdateInventoryEntryData,
  actor: ActorContext,
) => {
  // Guard against re-pointing the entry at a soft-deleted product/location.
  await assertLiveTargets(db, {
    productId: data.productId,
    locationId: data.locationId,
  });

  // Fetch current state for audit logging and valuation computation
  const before = await getDb(db).query.inventoryEntry.findFirst({
    where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
  });

  // Recompute valuation if amount or productId changed
  let valuation: number | null | undefined;
  if (data.amount !== undefined || data.productId !== undefined) {
    // Use new values if provided, otherwise use existing values
    const effectiveProductIdRaw = data.productId ?? before?.productId;
    const effectiveAmount = data.amount ?? before?.amount;
    const amountValue =
      typeof effectiveAmount === "object" && effectiveAmount !== null
        ? (effectiveAmount as { value: number }).value
        : 0;

    if (effectiveProductIdRaw) {
      const effectiveProductId = effectiveProductIdRaw;
      valuation = await computeValuationForEntry(
        db,
        effectiveProductId,
        amountValue,
      );
    }
  }

  // Build update values using helper to filter undefined
  const updateValues = buildPartialUpdateValues({
    amount: data.amount,
    productId: data.productId,
    locationId: data.locationId,
    valuation,
  });

  const updated = await updateLiveAndReturn(
    db,
    inventoryEntry,
    updateValues,
    id,
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
  // Guard against creating an entry pointed at a soft-deleted product/location.
  await assertLiveTargets(db, {
    productId: data.productId,
    locationId: data.locationId,
  });

  // Compute valuation based on amount and product price
  const amountValue =
    typeof data.amount === "object" && data.amount !== null
      ? (data.amount as { value: number }).value
      : 0;
  const valuation = await computeValuationForEntry(
    db,
    data.productId,
    amountValue,
  );

  const created = await insertAndReturn(db, inventoryEntry, {
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
    valuation,
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
    throw createAppError(
      "INVENTORY_NOT_FOUND",
      `Inventory entry not found after creation`,
    );
  }

  return dbInventoryEntryToAPI(result);
};

/**
 * Get inventory entries for multiple locations (batch query to avoid N+1).
 * Returns all inventory entries with product and location relations for the given location IDs.
 */
export const getInventoryByLocationIds = async (
  db: Database,
  locationIds: LocationId[],
) => {
  if (locationIds.length === 0) return [];

  const dbClient = getDb(db);
  const results = await dbClient.query.inventoryEntry.findMany({
    where: and(
      notDeleted(inventoryEntry),
      inArray(inventoryEntry.locationId, locationIds),
    ),
    ...relations.inventory.full,
  });

  return results.map(dbInventoryEntryToAPI);
};

/**
 * Get all non-deleted inventory amounts for a set of products (batch query to
 * avoid N+1). Returns flat {productId, amount} pairs; the caller groups and
 * converts them, since each entry's unit can differ and naive summing is wrong.
 */
export const getInventoryForProducts = async (
  db: Database,
  productIds: ProductId[],
): Promise<Array<{ productId: ProductId; amount: Amount }>> => {
  if (productIds.length === 0) return [];

  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, productIds),
      notDeleted(inventoryEntry),
    ),
    columns: { productId: true, amount: true },
  });

  return rows.map((row) => ({
    productId: row.productId,
    amount: row.amount,
  }));
};

/**
 * Soft delete inventory entries by IDs
 */
export const deleteInventoryEntries = async (
  db: Database,
  ids: InventoryId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  // Perform soft delete and audit logging in a transaction for atomicity
  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, inventoryEntry, ids, "Inventory");
    const now = new Date();
    await tx
      .update(inventoryEntry)
      .set({ deletedAt: now })
      .where(and(inArray(inventoryEntry.id, ids), notDeleted(inventoryEntry)));

    // Log audit entries in batch
    await logAuditEntries(
      tx,
      actor,
      ids.map((id) => ({
        entityType: "inventory" as const,
        entityId: id,
        action: "delete" as const,
      })),
    );
  });
};

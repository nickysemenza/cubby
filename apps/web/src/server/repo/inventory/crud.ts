import { and, count, eq, ilike, not } from "drizzle-orm";
import { getSortableFields } from "~/entities/entities";
import type { ActorContext } from "~/schemas/context";
import {
  type InventoryId,
  type LocationId,
  type OrganizationId,
  type ProductId,
  unsafeProductId,
} from "~/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import { computeInventoryValuation } from "~/schemas/price-mapping-utils";
import { createAppError } from "~/server/api/trpc";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  buildOrderBy,
  buildPartialUpdateValues,
  getDb,
  insertAndReturnDb,
  relations,
  unwrapDb,
  updateAndReturnDb,
} from "~/server/repo/database-helpers";
import { dbInventoryEntryToAPI } from "./helpers";
import type {
  CreateInventoryEntryData,
  UpdateInventoryEntryData,
} from "./types";

/**
 * Compute valuation for an inventory entry based on amount and product price.
 * Returns the valuation value to store.
 */
const computeValuationForEntry = async (
  db: Database,
  productId: ProductId,
  amountValue: number,
): Promise<number | null> => {
  const productData = await getDb(db).query.product.findFirst({
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

  // Get all inventory entries for this product
  const entries = await client.query.inventoryEntry.findMany({
    where: eq(inventoryEntry.productId, productId),
    columns: { id: true, amount: true },
  });

  let updated = 0;
  for (const entry of entries) {
    const amountValue =
      typeof entry.amount === "object" && entry.amount !== null
        ? (entry.amount as { value: number }).value
        : 0;
    const valuation = computeInventoryValuation(amountValue, productPrice);

    await client
      .update(inventoryEntry)
      .set({ valuation })
      .where(eq(inventoryEntry.id, entry.id));
    updated++;
  }

  return updated;
};

/**
 * Find inventory entries with stale or missing valuations.
 * Stale = stored valuation differs from computed (amount.value * product.price).
 */
export const findInventoryWithStaleValuations = async (
  db: Database,
  organizationId: OrganizationId,
): Promise<
  Array<{
    id: InventoryId;
    storedValuation: number | null;
    expectedValuation: number | null;
    productName: string;
    locationName: string;
  }>
> => {
  const entries = await getDb(db).query.inventoryEntry.findMany({
    where: eq(inventoryEntry.organizationId, organizationId),
    columns: { id: true, amount: true, valuation: true },
    with: {
      Product: { columns: { name: true, price: true } },
      location: { columns: { name: true } },
    },
  });

  const staleEntries: Array<{
    id: InventoryId;
    storedValuation: number | null;
    expectedValuation: number | null;
    productName: string;
    locationName: string;
  }> = [];

  for (const entry of entries) {
    const amountValue =
      typeof entry.amount === "object" && entry.amount !== null
        ? (entry.amount as { value: number }).value
        : 0;
    const expectedValuation = computeInventoryValuation(
      amountValue,
      entry.Product.price,
    );

    // Compare with tolerance for floating point
    const isStale =
      entry.valuation !== expectedValuation &&
      !(entry.valuation === null && expectedValuation === null);

    if (isStale) {
      staleEntries.push({
        id: entry.id as InventoryId,
        storedValuation: entry.valuation,
        expectedValuation,
        productName: entry.Product.name,
        locationName: entry.location.name,
      });
    }
  }

  return staleEntries;
};

/**
 * Backfill valuations for all inventory entries in an organization.
 * Returns count of updated entries.
 */
export const backfillInventoryValuations = async (
  db: Database,
  organizationId: OrganizationId,
): Promise<{ updated: number; skipped: number }> => {
  const entries = await getDb(db).query.inventoryEntry.findMany({
    where: eq(inventoryEntry.organizationId, organizationId),
    columns: { id: true, amount: true, valuation: true },
    with: {
      Product: { columns: { price: true } },
    },
  });

  let updated = 0;
  let skipped = 0;

  for (const entry of entries) {
    const amountValue =
      typeof entry.amount === "object" && entry.amount !== null
        ? (entry.amount as { value: number }).value
        : 0;
    const expectedValuation = computeInventoryValuation(
      amountValue,
      entry.Product.price,
    );

    // Only update if different
    if (entry.valuation !== expectedValuation) {
      await getDb(db)
        .update(inventoryEntry)
        .set({ valuation: expectedValuation })
        .where(eq(inventoryEntry.id, entry.id));
      updated++;
    } else {
      skipped++;
    }
  }

  return { updated, skipped };
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
  // Build order by using central sortableFields config
  const orderByArray = buildOrderBy(inventoryEntry, sort, [
    ...getSortableFields("inventory"),
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

  // Fetch current state for audit logging and valuation computation
  const before = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.id, id),
      eq(inventoryEntry.organizationId, organizationId),
    ),
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
      const effectiveProductId = unsafeProductId(effectiveProductIdRaw);
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

  const created = await insertAndReturnDb(db, inventoryEntry, {
    organizationId: organizationId,
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

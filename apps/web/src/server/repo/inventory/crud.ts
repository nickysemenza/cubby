import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type { ImpactItem } from "@cubby/schemas/entity-integrity";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import { inventorySortableFields } from "@cubby/schemas/inventory";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ProductCategory } from "@cubby/schemas/product";
import { and, asc, count, desc, eq, inArray, not, sql, sum } from "drizzle-orm";
import { computeInventoryValuation } from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityEmbedding,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  batchUpdateWithCaseWhen,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  eqAny,
  getDb,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import {
  countByTarget,
  impact,
  present,
  sideEffect,
} from "~/server/repo/impact";
import {
  loadEffectiveProductPrice,
  loadProductPricing,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { assertLiveTargets } from "./helpers";
import {
  dbInventoryEntryToAPI,
  dbInventoryEntryToListAPI,
  requireLoadedProductPricing,
} from "./mappers";
import { placementCondition, stockOnly } from "./placement";
import type {
  CreateInventoryEntryData,
  InventoryEntryDeepDB,
  UpdateInventoryEntryData,
} from "./types";

const loadInventoryEntryPricing = async (
  db: Database,
  entries: ReadonlyArray<{
    product: { id: ProductId; price: number | null };
  }>,
) =>
  loadProductPricing(
    db,
    entries.map((entry) => ({
      id: entry.product.id,
      price: entry.product.price,
    })),
  );

export const computeValuationForEntry = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
  amountValue: number,
): Promise<number | null> => {
  const client = unwrapDb(db);
  const productData = await client.query.product.findFirst({
    where: eq(product.id, productId),
    columns: { id: true, price: true },
  });
  const effectivePrice = productData
    ? await loadEffectiveProductPrice(db, productData)
    : null;
  return computeInventoryValuation(amountValue, effectivePrice);
};

export const syncInventoryValuationsForProduct = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
): Promise<number> => {
  const client = unwrapDb(db);

  const productData = await client.query.product.findFirst({
    where: eq(product.id, productId),
    columns: { id: true, price: true },
  });
  const productPrice = productData
    ? await loadEffectiveProductPrice(db, productData)
    : null;

  const entries = await client.query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true, amount: true },
  });

  if (entries.length === 0) return 0;

  const updates = entries.map((entry) => {
    const amountValue =
      typeof entry.amount === "object" && entry.amount !== null
        ? (entry.amount as { value: number }).value
        : 0;
    const valuation = computeInventoryValuation(amountValue, productPrice);

    return { id: entry.id, valuation };
  });

  const updated = await batchUpdateWithCaseWhen(
    client,
    inventoryEntry,
    updates,
  );

  return updated;
};

export const checkUniqueProductDuplicate = async (
  db: Database,
  productId: ProductId,
  locationId: LocationId,
): Promise<{ productName: string; locationName: string } | null> => {
  const productData = await getDb(db).query.product.findFirst({
    where: eq(product.id, productId),
    columns: { expectedQuantity: true, name: true },
  });

  if (productData?.expectedQuantity === 1) {
    const existingEntry = await getDb(db).query.inventoryEntry.findFirst({
      // Scoped to stock. A spare faucet on the shelf plus one wired into the
      // wall is the normal correct state for a single-unit product, not a
      // duplicate worth warning about.
      where: and(
        eq(inventoryEntry.productId, productId),
        not(eq(inventoryEntry.locationId, locationId)),
        stockOnly(),
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

const fetchInventoryById = async (
  db: Database,
  id: InventoryId,
): Promise<InventoryEntryDeepDB | undefined> => {
  const row = await getDb(db).query.inventoryEntry.findFirst({
    where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
    ...relations.inventory.full,
  });
  return row;
};

// Read path through the shared reader. The write path stays hand-rolled: create/
// update recompute valuation from the product price and guard live targets.
const inventoryReader = createEntityReader({
  entity: "inventory",
  fetchById: fetchInventoryById,
  fromDB: async (db, row: InventoryEntryDeepDB) => {
    const pricing = await loadInventoryEntryPricing(db, [row]);
    return dbInventoryEntryToAPI(
      row,
      requireLoadedProductPricing(pricing, row.product.id),
    );
  },
});

export const getInventoryEntryByID = (db: Database, id: InventoryId) =>
  inventoryReader.getByIDOrNull(db, id);

export const getInventoryEntryByShortcode = (db: Database, shortcode: string) =>
  inventoryReader.getByShortcode(db, shortcode);

interface InventoryFilters {
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  productNameFilter?: string;
  locationNameFilter?: string;
  locationIdFilter?: LocationId;
  productIdFilter?: ProductId;
  manufacturerFilter?: string;
  categoryFilter?: ProductCategory | ProductCategory[];
  verifiedPresenceFilter?: "has" | "none";
  verifiedFrom?: string;
  verifiedTo?: string;
  placementFilter?: InventoryPlacement | "all";
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

  const results = await dbClient
    .select({
      locationId: inventoryEntry.locationId,
      count: sql<number>`count(*)::int`,
    })
    .from(inventoryEntry)
    .where(
      and(
        notDeleted(inventoryEntry),
        // The only caller is the per-location count badge, which answers "how
        // many things are here to count" — a fixture is not one of them.
        stockOnly(),
        inArray(inventoryEntry.locationId, locationIds),
      ),
    )
    .groupBy(inventoryEntry.locationId);

  const countMap: Record<string, number> = {};
  for (const row of results) {
    countMap[row.locationId] = row.count;
  }

  for (const locationId of locationIds) {
    if (!(locationId in countMap)) {
      countMap[locationId] = 0;
    }
  }

  return countMap;
};

// Joined-column sorts the generic table-column path can't produce. Clauses
// only DEFINE the field's order — the createdAt tie-break moved to the single
// trailing tieBreaker so it can't swallow a stacked secondary sort.
const resolveInventorySort = (sort: SortParams) => {
  const direction = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "name" || sort.orderBy === "product") {
    return [direction(product.name)];
  }
  if (sort.orderBy === "location") {
    return [direction(location.name)];
  }
  return null;
};

const inventoryListOrderBy = (sorts: SortParams[]) =>
  buildOrderBy(inventoryEntry, sorts, [...inventorySortableFields], {
    resolve: resolveInventorySort,
    tieBreaker: desc(inventoryEntry.createdAt),
  });

export const inventoryentryList = async (
  db: Database,
  filters: InventoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) => {
  const { take, skip } = buildTakeSkip(pagination);

  const whereCondition = buildSearchConditions(
    inventoryEntry,
    [
      { column: product.name, term: filters.productNameFilter },
      { column: location.name, term: filters.locationNameFilter },
      { column: product.manufacturer, term: filters.manufacturerFilter },
    ],
    [
      ...auditDateWhereConditions(inventoryEntry, filters),
      ...relatedWhereConditions(
        "inventory",
        filters as unknown as Record<string, unknown>,
        inventoryEntry.id,
      ),
      filters.locationIdFilter
        ? eq(inventoryEntry.locationId, filters.locationIdFilter)
        : undefined,
      filters.productIdFilter
        ? eq(inventoryEntry.productId, filters.productIdFilter)
        : undefined,
      eqAny(product.category, filters.categoryFilter),
      filters.verifiedPresenceFilter === "has"
        ? sql`${inventoryEntry.verifiedAt} IS NOT NULL`
        : filters.verifiedPresenceFilter === "none"
          ? sql`${inventoryEntry.verifiedAt} IS NULL`
          : undefined,
      filters.verifiedFrom
        ? sql`${inventoryEntry.verifiedAt} >= ${filters.verifiedFrom}::date`
        : undefined,
      filters.verifiedTo
        ? sql`${inventoryEntry.verifiedAt} < (${filters.verifiedTo}::date + interval '1 day')`
        : undefined,
      // The browse contract: an omitted filter means movable stock, NOT
      // everything. Defaulted here rather than in zod so the UI, MCP
      // `list_inventory`, and any direct tRPC caller cannot disagree about what
      // an empty filter means — pass "all" to opt back in.
      placementCondition(filters.placementFilter ?? "stock"),
    ],
  );

  const baseQuery = getDb(db)
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
    .where(whereCondition);

  const [results, [countResult]] = await Promise.all([
    baseQuery
      .orderBy(...inventoryListOrderBy(sorts))
      .limit(take)
      .offset(skip),
    // Count + valuation aggregate share the joins/filters, so the footer's
    // valuation total covers the FULL filtered set (client only holds a page).
    getDb(db)
      .select({
        count: count(),
        valuationSum: sum(inventoryEntry.valuation),
      })
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

  // Preserve original order from the paged query.
  const resultsById = new Map(listResults.map((r) => [r.id, r]));
  const orderedResults = ids
    .map((id) => resultsById.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);
  const pricing = await loadInventoryEntryPricing(db, orderedResults);
  const inventoryEntries = orderedResults.map((entry) =>
    dbInventoryEntryToListAPI(
      entry,
      requireLoadedProductPricing(pricing, entry.product.id),
    ),
  );
  const valuationSum = Number(countResult?.valuationSum ?? 0);
  return {
    data: inventoryEntries,
    count: countResult?.count ?? 0,
    sums: { valuation: Number.isNaN(valuationSum) ? 0 : valuationSum },
  };
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

  const before = await getDb(db).query.inventoryEntry.findFirst({
    where: and(eq(inventoryEntry.id, id), notDeleted(inventoryEntry)),
  });

  let valuation: number | null | undefined;
  if (data.amount !== undefined || data.productId !== undefined) {
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

  const updateValues = buildPartialUpdateValues({
    amount: data.amount,
    productId: data.productId,
    locationId: data.locationId,
    // Flipping placement is how something becomes (or stops being) a fixture.
    // It does NOT move the row — the dimmer stays in the kitchen, it just stops
    // being counted, audited, and browsed.
    placement: data.placement,
    valuation,
  });

  const updated = await updateLiveAndReturn(
    db,
    inventoryEntry,
    updateValues,
    id,
  );

  if (before) {
    const changes = computeChanges(before, updated, [
      "amount",
      "productId",
      "locationId",
      // A placement flip changes what every count, audit and browse surface
      // reports about this row, so it belongs in the audit trail even though
      // nothing about the physical object moved.
      "placement",
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

  const pricing = await loadInventoryEntryPricing(db, [result]);
  return dbInventoryEntryToAPI(
    result,
    requireLoadedProductPricing(pricing, result.product.id),
  );
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

  const amountValue =
    typeof data.amount === "object" && data.amount !== null
      ? (data.amount as { value: number }).value
      : 0;
  const valuation = await computeValuationForEntry(
    db,
    data.productId,
    amountValue,
  );

  const created = await insertWithShortcode(db, "inventory", {
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
    ...(data.placement ? { placement: data.placement } : {}),
    valuation,
  });

  await logAuditEntry(db, actor, {
    entityType: "inventory",
    entityId: created.id,
    action: "create",
  });

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

  const pricing = await loadInventoryEntryPricing(db, [result]);
  return dbInventoryEntryToAPI(
    result,
    requireLoadedProductPricing(pricing, result.product.id),
  );
};

/**
 * Get inventory entries for multiple locations (batch query to avoid N+1).
 * Returns all inventory entries with product and location relations for the given location IDs.
 */
/**
 * Two callers with opposite needs, so placement is a parameter and the default
 * is "all" rather than the browse default.
 *
 * The audit session passes "stock" — a recount cannot include fixtures, and the
 * predicate it uses here MUST match the snapshot queries inside
 * `reconcileLocationSession`, or the stale guard compares two different
 * populations and throws INVENTORY_STALE on every commit. The location card
 * grid passes nothing and keeps its existing behaviour.
 */
export const getInventoryByLocationIds = async (
  db: Database,
  locationIds: LocationId[],
  options: { placement?: InventoryPlacement | "all" } = {},
) => {
  if (locationIds.length === 0) return [];

  const dbClient = getDb(db);
  const results = await dbClient.query.inventoryEntry.findMany({
    where: and(
      notDeleted(inventoryEntry),
      placementCondition(options.placement ?? "all"),
      inArray(inventoryEntry.locationId, locationIds),
    ),
    ...relations.inventory.full,
  });

  const pricing = await loadInventoryEntryPricing(db, results);
  return results.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      requireLoadedProductPricing(pricing, entry.product.id),
    ),
  );
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

export const deleteInventoryEntries = async (
  db: Database,
  ids: InventoryId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, inventoryEntry, ids, "Inventory");
    await removeEntity(tx, {
      entity: "inventory",
      ids,
      removal: "soft",
      actor,
    });
  });
};

/**
 * What `deleteInventoryEntries` would do to the given entries, without doing
 * it.
 *
 * `inventory` has zero incoming edges (`INCOMING_EDGES.inventory` is `{}` —
 * see `entity-incoming-edges.ts`), so there is nothing to block or cascade:
 * `blockers` and `changes` are always empty. Two real consequences instead,
 * both read straight off the actual delete paths rather than invented:
 *
 *  1. **Search index removal.** `deleteInventoryEntries` above soft-deletes
 *     the entry's `EntityEmbedding` row in the same transaction (via
 *     `removeEntity`'s cascade). Counted here
 *     with the SAME predicate that call uses (entityType match + `inArray` +
 *     `notDeleted`), via `countByTarget`, so the two can't disagree.
 *  2. **Location valuation recompute.** `needsValuationRecompute` in
 *     `services/mutation-side-effects.ts` returns `true` unconditionally for
 *     entityType `"inventory"` — create, update, AND delete alike — so the
 *     router's delete procedure (`inventory.ts`'s `deleteItem`, via
 *     `runMutationSideEffectsForEntities`) dispatches a background whole-tree
 *     location-valuation recompute for every entry deleted. Unlike the
 *     embedding cleanup this is a background job dispatch, not a per-row DB
 *     write, so it has no natural row count — reported via `sideEffect()`
 *     rather than `impact()`.
 *
 * Advisory only. `deleteInventoryEntries` still re-runs its own transaction;
 * nothing here is a lock or a permission.
 */
export const previewDeleteInventoryEntries = async (
  db: Database,
  ids: InventoryId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);

  const sideEffects = present([
    impact({
      disposition: {
        code: "soft-delete-search-index",
        effect: "soft-delete",
        description:
          "The inventory entry's search-index entry is soft-deleted in the same transaction as the delete.",
      },
      label: "search index entries",
      byTargetId: await countByTarget(
        dbClient,
        entityEmbedding,
        entityEmbedding.entityId,
        ids,
        { extraWhere: eq(entityEmbedding.entityType, "inventory") },
      ),
    }),
    sideEffect({
      code: "location-valuation-recompute",
      effect: "preserve",
      label: "location valuation recompute",
      description:
        "Deleting an inventory entry always triggers a background whole-tree location-valuation recompute.",
      total: ids.length,
      byTargetId: Object.fromEntries(ids.map((id) => [id, 1])),
    }),
  ]);

  return { blockers: [], changes: [], sideEffects };
};

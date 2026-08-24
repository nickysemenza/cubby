import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type {
  InventoryId,
  LocationId,
  LocationShortcode,
  ProductId,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import { inventorySortableFields } from "@cubby/schemas/inventory";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type { ProductCategory } from "@cubby/schemas/product";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  sql,
  sum,
} from "drizzle-orm";
import {
  computeInventoryValuation,
  computeInventoryValuations,
} from "~/lib/price-mapping-utils";
import type { Database, DrizzleTransaction } from "~/server/db";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  auditDateWhereConditions,
  batchUpdateWithCaseWhen,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  eqAny,
  eqAnyRequested,
  getDb,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  parseInventoryAmount,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { isGlobalUnknownLocation } from "~/server/repo/location";
import {
  effectiveProductPriceSql,
  loadProductPricing,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import { resolveFilterIds } from "~/server/repo/shortcode-resolver";
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
import { loadValuationGraph } from "./valuation";

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

/**
 * Value one entry's amount against its Product's conversion graph. Takes the
 * whole `Amount`, not a scalar: the unit is what decides whether "4" means four
 * packs or four rolls out of one.
 */
export const computeValuationForEntry = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
  amount: Amount,
): Promise<number | null> =>
  computeInventoryValuation(amount, await loadValuationGraph(db, productId));

/**
 * Re-value every live entry of a Product after its effective price moved. One
 * graph load and ONE batched WASM call for the whole fan-out.
 *
 * Rows whose valuation is unchanged are skipped, so the returned count is rows
 * *changed*, not rows examined (no current caller reads it). That matters
 * because `batchUpdateWithCaseWhen` sets `updatedAt` unconditionally: without
 * the skip, every price change touches every live entry of the product, which
 * is noise in the data-quality fingerprints and can trip the `INVENTORY_STALE`
 * guard in `bulk.ts` for a recount session that changed nothing.
 */
export const syncInventoryValuationsForProduct = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
): Promise<number> => {
  const client = unwrapDb(db);

  const entries = await client.query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true, amount: true, valuation: true },
  });

  if (entries.length === 0) return 0;

  const mappings = await loadValuationGraph(db, productId);
  const valuations = computeInventoryValuations(
    entries.map((entry) => parseInventoryAmount(entry.amount, entry.id)),
    mappings,
  );

  // Compared with `===` against a value read back from a `real` (float4)
  // column, which looks fragile and isn't: Postgres emits floats as the
  // SHORTEST text that round-trips to the same float4, so a stored 37.98 comes
  // back as "37.98" and parses to the identical float64. Verified against this
  // database, and it holds even at `extra_float_digits = -1` and at eight
  // significant figures — well past the ~$12k ceiling of any real valuation.
  //
  // Where it would stop skipping: a magnitude large enough that float4 can no
  // longer round-trip the cent (~8+ significant figures), where Postgres
  // switches to scientific notation. The failure is benign — the row is
  // rewritten with the number it already had — so this stays a plain compare
  // rather than a cents-scaled one that would imply the equality is unsound.
  const updates = entries.flatMap((entry, index) => {
    const valuation = valuations[index] ?? null;
    return entry.valuation === valuation ? [] : [{ id: entry.id, valuation }];
  });
  if (updates.length === 0) return 0;

  return batchUpdateWithCaseWhen(client, inventoryEntry, updates);
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

export const getInventoryEntryByShortcode = (db: Database, shortcode: string) =>
  inventoryReader.getByShortcode(db, shortcode);

interface InventoryFilters {
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  productNameFilter?: string;
  locationNameFilter?: string;
  // Public codes, resolved to uuids inside `inventoryentryList` — see
  // `resolveFilterIds`. A code naming no live row narrows to nothing; it is
  // not a 404 for the whole list.
  locationIdFilter?: LocationShortcode;
  productIdFilter?: ProductShortcode;
  manufacturerFilter?: string;
  categoryFilter?: ProductCategory | ProductCategory[];
  verifiedPresenceFilter?: "has" | "none";
  valuationStatus?: "valued" | "missing" | "missing_with_priced_product";
  verifiedFrom?: string;
  verifiedTo?: string;
  placementFilter?: InventoryPlacement | "all";
  locationRole?: "global_unknown";
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
  readIntent: ListReadIntent = "page",
) => {
  const { take, skip } = buildTakeSkip(pagination);
  const [locationIds, productIds] = await Promise.all([
    resolveFilterIds(db, "location", filters.locationIdFilter),
    resolveFilterIds(db, "product", filters.productIdFilter),
  ]);

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
      eqAnyRequested(inventoryEntry.locationId, locationIds),
      eqAnyRequested(inventoryEntry.productId, productIds),
      eqAny(product.category, filters.categoryFilter),
      filters.locationRole === "global_unknown"
        ? isGlobalUnknownLocation()
        : undefined,
      filters.verifiedPresenceFilter === "has"
        ? sql`${inventoryEntry.verifiedAt} IS NOT NULL`
        : filters.verifiedPresenceFilter === "none"
          ? sql`${inventoryEntry.verifiedAt} IS NULL`
          : undefined,
      filters.valuationStatus === "valued"
        ? isNotNull(inventoryEntry.valuation)
        : filters.valuationStatus === "missing"
          ? isNull(inventoryEntry.valuation)
          : filters.valuationStatus === "missing_with_priced_product"
            ? and(
                isNull(inventoryEntry.valuation),
                sql`${sql.raw(effectiveProductPriceSql('"Product"'))} IS NOT NULL`,
              )
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

  if (readIntent === "count") {
    const [result] = await getDb(db)
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
      .where(whereCondition);
    return {
      data: [],
      count: result?.count ?? 0,
      // Count-only consumers deliberately do not request table footers.
      sums: { valuation: 0 },
    };
  }

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
        valuationSum:
          readIntent === "sample"
            ? sql<number>`0`
            : sum(inventoryEntry.valuation),
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
    const effectiveProductId = data.productId ?? before?.productId;
    const effectiveAmount = data.amount ?? before?.amount;
    if (effectiveProductId && effectiveAmount) {
      valuation = await computeValuationForEntry(
        db,
        effectiveProductId,
        effectiveAmount,
      );
    }
  }

  // Pre-check the slot rather than letting the partial unique index raise a
  // raw 23505 — nothing maps that to an AppError, so it would surface as an
  // untranslated Postgres error. Same reasoning as the charge pre-check in
  // `purchase.ts`.
  //
  // The slot is `(productId, locationId, placement)`, so ANY of the three can
  // collide: re-pointing an entry at a product/location that already has one,
  // or — newly reachable since placement joined the key — marking a stock row
  // installed when an installed row of that product already sits in that room.
  // That pair is legitimate, which is exactly why the key allows it, so this is
  // reachable by design rather than a corrupt state.
  if (
    before &&
    (data.productId !== undefined ||
      data.locationId !== undefined ||
      data.placement !== undefined)
  ) {
    const targetProductId = data.productId ?? before.productId;
    const targetLocationId = data.locationId ?? before.locationId;
    const targetPlacement = data.placement ?? before.placement;
    const occupant = await getDb(db).query.inventoryEntry.findFirst({
      where: and(
        eq(inventoryEntry.productId, targetProductId),
        eq(inventoryEntry.locationId, targetLocationId),
        eq(inventoryEntry.placement, targetPlacement),
        not(eq(inventoryEntry.id, id)),
        notDeleted(inventoryEntry),
      ),
      columns: { shortcode: true },
    });
    if (occupant) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Another ${targetPlacement} entry for this product already sits at this location (${occupant.shortcode}). Merge them by moving one onto the other instead.`,
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

  const valuation = await computeValuationForEntry(
    db,
    data.productId,
    data.amount,
  );

  const created = await insertWithShortcode(db, "inventory", {
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
    ...(data.placement ? { placement: data.placement } : {}),
    ...(data.verifiedAt ? { verifiedAt: data.verifiedAt } : {}),
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
): Promise<{ deleted: number }> => {
  if (ids.length === 0) return { deleted: 0 };

  return await withTransaction(db, async (tx) => {
    await lockAndValidateForDelete(tx, inventoryEntry, ids, "Inventory");
    const { deleted } = await removeEntity(tx, {
      entity: "inventory",
      ids,
      removal: "soft",
      actor,
    });
    return { deleted };
  });
};

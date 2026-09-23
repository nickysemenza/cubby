import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type { DataQualityStatus } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import type {
  InventoryId,
  LocationId,
  LocationShortcode,
  ProductId,
  ProductCategoryShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
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
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  dataQualityFilterPredicates,
  dataQualitySortResolver,
  loadDataQualities,
} from "~/server/repo/data-quality";
import {
  auditDateWhereConditions,
  batchUpdateWithCaseWhen,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
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
import { declaredFilterPredicates } from "~/server/repo/declared-filter-predicates";
import { createEntityReader } from "~/server/repo/entity-crud-factory";
import { isGlobalUnknownLocation } from "~/server/repo/location";
import { categoryDescendantsSql } from "~/server/repo/product-category-sql";
import {
  effectiveProductPriceSql,
  loadProductPricing,
} from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  lexicalEligibility,
  lexicalRelevance,
} from "~/server/repo/search-lexical";
import { resolveFilterIds } from "~/server/repo/shortcode-resolver";

// InventoryEntry has no incoming foreign keys. Keep the empty policy explicit
// so a newly introduced reference must be classified before kernel deletion
// can remain registered.
export const INVENTORY_DELETE_EDGE_POLICY =
  {} as const satisfies IncomingEdgePolicy<"inventory", OperationDisposition>;

import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { assertLiveTargets } from "./helpers";
import {
  dbInventoryEntryToAPI,
  dbInventoryEntryToListAPI,
  requireLoadedProductPricing,
} from "./mappers";
import {
  assertIndividualOwner,
  loadEffectiveInventoryOwnership,
} from "./ownership";
import {
  liveProductAndLocation,
  placementCondition,
  stockOnly,
} from "./placement";
import {
  assertValidRawInventoryOwnership,
  inventoryOwnershipSlotCondition,
  type InventoryRawOwnership,
} from "./slot";
import type {
  CreateInventoryEntryData,
  InventoryEntryDeepDB,
  UpdateInventoryEntryData,
} from "./types";
import { loadValuationGraph, loadValuationGraphs } from "./valuation";

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
export const syncInventoryValuationsForProducts = async (
  db: Database | DrizzleTransaction,
  productIds: readonly ProductId[],
): Promise<number> => {
  const client = unwrapDb(db);
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return 0;

  const entries = await client.query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, ids),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true, productId: true, amount: true, valuation: true },
  });

  if (entries.length === 0) return 0;

  const graphs = await loadValuationGraphs(db, ids);

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
  const entriesByProduct = new Map<ProductId, typeof entries>();
  for (const entry of entries) {
    const group = entriesByProduct.get(entry.productId) ?? [];
    group.push(entry);
    entriesByProduct.set(entry.productId, group);
  }
  const updates = [...entriesByProduct].flatMap(([productId, rows]) => {
    const valuations = computeInventoryValuations(
      rows.map((entry) => parseInventoryAmount(entry.amount, entry.id)),
      graphs.get(productId) ?? [],
    );
    return rows.flatMap((entry, index) => {
      const valuation = valuations[index] ?? null;
      return entry.valuation === valuation ? [] : [{ id: entry.id, valuation }];
    });
  });
  if (updates.length === 0) return 0;

  return batchUpdateWithCaseWhen(client, inventoryEntry, updates);
};

export const syncInventoryValuationsForProduct = async (
  db: Database | DrizzleTransaction,
  productId: ProductId,
): Promise<number> => syncInventoryValuationsForProducts(db, [productId]);

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
    const [pricing, ownership, dataQualities, locationQualities] =
      await Promise.all([
        loadInventoryEntryPricing(db, [row]),
        loadEffectiveInventoryOwnership(db, [row]),
        loadDataQualities(db, "inventory", [row.id]),
        loadDataQualities(db, "location", [row.location.id]),
      ]);
    return dbInventoryEntryToAPI(
      row,
      requireLoadedProductPricing(pricing, row.product.id),
      // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
      dataQualities.get(row.id)!,
      locationQualities.get(row.location.id)!,
      ownership.get(row.id),
    );
  },
});

export const getInventoryEntryByShortcode = (db: Database, shortcode: string) =>
  inventoryReader.getByShortcode(db, shortcode);

interface InventoryFilters {
  searchQuery?: string;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
  productNameFilter?: string;
  locationNameFilter?: string;
  // Public codes, resolved to uuids inside `inventoryentryList` — see
  // `resolveFilterIds`. A code naming no live row narrows to nothing; it is
  // not a 404 for the whole list.
  locationIdFilter?: LocationShortcode | typeof UNRESOLVABLE_ENTITY_FILTER;
  productIdFilter?: ProductShortcode | typeof UNRESOLVABLE_ENTITY_FILTER;
  manufacturerFilter?: string;
  categoryFilter?: ProductCategoryShortcode | ProductCategoryShortcode[];
  verifiedPresenceFilter?: "has" | "none";
  valuationStatus?: "valued" | "missing" | "missing_with_priced_product";
  verifiedFrom?: string;
  verifiedTo?: string;
  placementFilter?: InventoryPlacement | "all";
  locationRole?: "global_unknown";
  dataStatus?: DataQualityStatus | DataQualityStatus[];
  dataGap?: string | string[];
}

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

const inventoryScoreSort = dataQualitySortResolver("inventory", inventoryEntry);

const inventoryListOrderBy = (
  sorts: SortParams[],
  filters: InventoryFilters,
) => {
  if (filters.searchQuery?.trim() && sorts.length === 0) {
    return [
      asc(
        lexicalRelevance("inventory", inventoryEntry.id, filters.searchQuery),
      ),
      desc(inventoryEntry.updatedAt),
      asc(inventoryEntry.shortcode),
    ];
  }
  return buildOrderBy(
    inventoryEntry,
    sorts,
    [...generatedEntitySort.inventory.fields],
    {
      resolve: (sort) => inventoryScoreSort(sort) ?? resolveInventorySort(sort),
      tieBreaker: desc(inventoryEntry.createdAt),
    },
  );
};

/**
 * The complete WHERE for an inventory list. `getEntityCounts` calls it with
 * `{}` — see repo/dashboard.ts.
 *
 * Includes {@link liveProductAndLocation}, the predicate form of the two
 * `INNER JOIN`s below. Folding it in HERE rather than only into the count path
 * is what makes this honest: rows, count, and the valuation aggregate all
 * narrow the same way, and a caller with no joins gets the same population.
 */
// Not on `listScaffold`: the text searches run over the JOINED product and
// location tables, not this entity's own columns, so no declared stored
// predicate can express them.
export const buildInventoryWhere = async (
  db: Database,
  filters: InventoryFilters,
) => {
  const [locationIds, productIds, categoryIds] = await Promise.all([
    resolveFilterIds(db, "location", filters.locationIdFilter),
    resolveFilterIds(db, "product", filters.productIdFilter),
    resolveFilterIds(db, "productCategory", filters.categoryFilter),
  ]);

  return buildSearchConditions(
    inventoryEntry,
    [
      { column: product.name, term: filters.productNameFilter },
      { column: location.name, term: filters.locationNameFilter },
      { column: product.manufacturer, term: filters.manufacturerFilter },
    ],
    [
      ...auditDateWhereConditions(inventoryEntry, filters),
      ...relatedWhereConditions("inventory", filters, inventoryEntry.id),
      // Stored id filters (`ownerLedgerPartyId`) come from the manifest; this
      // hand-built where must apply them since it is not on `listScaffold`.
      ...declaredFilterPredicates("inventory", inventoryEntry, filters),
      lexicalEligibility("inventory", inventoryEntry.id, filters.searchQuery),
      eqAnyRequested(inventoryEntry.locationId, locationIds),
      eqAnyRequested(inventoryEntry.productId, productIds),
      categoryIds === undefined
        ? undefined
        : sql`${product.categoryId} IN ${categoryDescendantsSql(categoryIds)}`,
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
      // `list_inventory`, and any direct workflow caller cannot disagree about what
      // an empty filter means — pass "all" to opt back in.
      placementCondition(filters.placementFilter ?? "stock"),
      liveProductAndLocation(),
      ...dataQualityFilterPredicates("inventory", inventoryEntry, filters),
    ],
  );
};

export const inventoryentryList = async (
  db: Database,
  filters: InventoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
  const { take, skip } = buildTakeSkip(pagination);
  const whereCondition = await buildInventoryWhere(db, filters);

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
      .orderBy(...inventoryListOrderBy(sorts, filters))
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
  const [pricing, ownership, dataQualities] = await Promise.all([
    loadInventoryEntryPricing(db, orderedResults),
    loadEffectiveInventoryOwnership(db, orderedResults),
    loadDataQualities(
      db,
      "inventory",
      orderedResults.map((entry) => entry.id),
    ),
  ]);
  const inventoryEntries = await withDisplayImages(
    db,
    "inventory",
    orderedResults,
    (entry) =>
      dbInventoryEntryToListAPI(
        entry,
        requireLoadedProductPricing(pricing, entry.product.id),
        // SAFETY: `entry` came from `orderedResults`, which `dataQualities` was
        // loaded for.
        dataQualities.get(entry.id)!,
        ownership.get(entry.id),
      ),
  );
  const valuationSum = Number(countResult?.valuationSum ?? 0);
  return {
    data: inventoryEntries,
    count: countResult?.count ?? 0,
    sums: { valuation: Number.isNaN(valuationSum) ? 0 : valuationSum },
  };
};

type InventoryRow = typeof inventoryEntry.$inferSelect;

const resolveUpdatedOwnership = (
  before: InventoryRow,
  data: UpdateInventoryEntryData,
): InventoryRawOwnership => ({
  ownershipMode: data.ownershipMode ?? before.ownershipMode,
  ownerLedgerPartyId:
    data.ownerLedgerPartyId !== undefined
      ? data.ownerLedgerPartyId
      : data.ownershipMode !== undefined && data.ownershipMode !== "person"
        ? null
        : before.ownerLedgerPartyId,
});

const validateUpdatedOwnership = async (
  db: Database,
  ownership: InventoryRawOwnership,
) => {
  try {
    assertValidRawInventoryOwnership(ownership);
  } catch {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Person ownership requires an individual owner; inherited and unassigned ownership cannot retain one.",
    );
  }
  if (!ownership.ownerLedgerPartyId) return;
  try {
    await assertIndividualOwner(getDb(db), ownership.ownerLedgerPartyId);
  } catch {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Inventory can only be assigned to a live member or guest.",
    );
  }
};

const updatedInventoryValuation = async (
  db: Database,
  before: InventoryRow,
  data: UpdateInventoryEntryData,
) => {
  if (data.amount === undefined && data.productId === undefined)
    return undefined;
  return await computeValuationForEntry(
    db,
    data.productId ?? before.productId,
    data.amount ?? before.amount,
  );
};

const changesInventorySlot = (data: UpdateInventoryEntryData) =>
  data.productId !== undefined ||
  data.locationId !== undefined ||
  data.placement !== undefined ||
  data.ownershipMode !== undefined ||
  data.ownerLedgerPartyId !== undefined;

const assertUpdatedSlotAvailable = async (
  db: Database,
  id: InventoryId,
  before: InventoryRow,
  data: UpdateInventoryEntryData,
  ownership: InventoryRawOwnership,
) => {
  if (!changesInventorySlot(data)) return;
  const targetPlacement = data.placement ?? before.placement;
  const occupant = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, data.productId ?? before.productId),
      eq(inventoryEntry.locationId, data.locationId ?? before.locationId),
      eq(inventoryEntry.placement, targetPlacement),
      inventoryOwnershipSlotCondition(ownership),
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

  if (!before) {
    throw createAppError(
      "INVENTORY_NOT_FOUND",
      `Inventory entry ${id} not found`,
    );
  }
  const rawOwnership = resolveUpdatedOwnership(before, data);
  await validateUpdatedOwnership(db, rawOwnership);
  const valuation = await updatedInventoryValuation(db, before, data);

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
  await assertUpdatedSlotAvailable(db, id, before, data, rawOwnership);

  const updateValues = buildPartialUpdateValues({
    amount: data.amount,
    productId: data.productId,
    locationId: data.locationId,
    // Flipping placement is how something becomes (or stops being) a fixture.
    // It does NOT move the row — the dimmer stays in the kitchen, it just stops
    // being counted, audited, and browsed.
    placement: data.placement,
    ownershipMode: data.ownershipMode,
    ownerLedgerPartyId:
      data.ownershipMode !== undefined || data.ownerLedgerPartyId !== undefined
        ? rawOwnership.ownerLedgerPartyId
        : undefined,
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
      ...entityFieldModels.inventory.audit,
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

  const [pricing, ownership, dataQualities, locationQualities] =
    await Promise.all([
      loadInventoryEntryPricing(db, [result]),
      loadEffectiveInventoryOwnership(db, [result]),
      loadDataQualities(db, "inventory", [result.id]),
      loadDataQualities(db, "location", [result.location.id]),
    ]);
  // SAFETY: `result` was just fetched live by id, so its quality was evaluated.
  return dbInventoryEntryToAPI(
    result,
    requireLoadedProductPricing(pricing, result.product.id),
    dataQualities.get(result.id)!,
    locationQualities.get(result.location.id)!,
    ownership.get(result.id),
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
  const ownershipMode = data.ownershipMode ?? "inherit";
  const ownerLedgerPartyId = data.ownerLedgerPartyId ?? null;
  try {
    assertValidRawInventoryOwnership({ ownershipMode, ownerLedgerPartyId });
  } catch {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Person ownership requires an individual owner; inherited and unassigned ownership cannot retain one.",
    );
  }
  if (ownerLedgerPartyId) {
    try {
      await assertIndividualOwner(getDb(db), ownerLedgerPartyId);
    } catch {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Inventory can only be assigned to a live member or guest.",
      );
    }
  }

  const placement = data.placement ?? "stock";
  const occupant = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, data.productId),
      eq(inventoryEntry.locationId, data.locationId),
      eq(inventoryEntry.placement, placement),
      inventoryOwnershipSlotCondition({
        ownershipMode,
        ownerLedgerPartyId,
      }),
      notDeleted(inventoryEntry),
    ),
    columns: { shortcode: true },
  });
  if (occupant) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Another ${placement} entry for this product already sits at this location (${occupant.shortcode}). Add to or move into that entry instead.`,
    );
  }

  const values: Omit<typeof inventoryEntry.$inferInsert, "shortcode"> = {
    productId: data.productId,
    locationId: data.locationId,
    amount: data.amount,
    valuation,
    ownershipMode,
    ownerLedgerPartyId,
  };
  if (data.placement) values.placement = data.placement;
  if (data.verifiedAt) values.verifiedAt = data.verifiedAt;
  const created = await insertWithShortcode(db, "inventory", values);

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

  const [pricing, ownership, dataQualities, locationQualities] =
    await Promise.all([
      loadInventoryEntryPricing(db, [result]),
      loadEffectiveInventoryOwnership(db, [result]),
      loadDataQualities(db, "inventory", [result.id]),
      loadDataQualities(db, "location", [result.location.id]),
    ]);
  // SAFETY: `result` was just fetched live by id, so its quality was evaluated.
  return dbInventoryEntryToAPI(
    result,
    requireLoadedProductPricing(pricing, result.product.id),
    dataQualities.get(result.id)!,
    locationQualities.get(result.location.id)!,
    ownership.get(result.id),
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

  const [pricing, ownership, dataQualities, locationQualities] =
    await Promise.all([
      loadInventoryEntryPricing(db, results),
      loadEffectiveInventoryOwnership(db, results),
      loadDataQualities(
        db,
        "inventory",
        results.map((entry) => entry.id),
      ),
      loadDataQualities(
        db,
        "location",
        results.map((entry) => entry.location.id),
      ),
    ]);
  return results.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      requireLoadedProductPricing(pricing, entry.product.id),
      // SAFETY: `entry` came from `results`, which `dataQualities`/
      // `locationQualities` were loaded for.
      dataQualities.get(entry.id)!,
      locationQualities.get(entry.location.id)!,
      ownership.get(entry.id),
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

import type { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";

import { withDisplayImages } from "~/server/repo/entity-display-image";

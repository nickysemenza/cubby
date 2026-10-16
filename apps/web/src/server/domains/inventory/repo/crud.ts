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
import {
  inventoryDisplayName,
  inventoryListItemOut,
} from "@cubby/schemas/inventory";
import type {
  InventoryPlacement,
  inventoryFiltersSchema,
} from "@cubby/schemas/inventory";
import {
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
  not,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type { z } from "zod";

import { projectListRows } from "~/entity/model/list-read-schema";
import type { Database } from "~/server/db";
import { categoryFeatureInSql } from "~/server/db/computed/product-category-sql";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  amountFromColumns,
  amountToColumns,
  auditDateWhereConditions,
  householdDayRangeConditions,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  eqAnyRequested,
  getDb,
  type ListReadIntent,
  notDeleted,
  relations,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { inventoryEntry, location, product } from "~/server/db/schema";
import {
  effectiveProductPriceSql,
  loadProductPricing,
} from "~/server/domains/product/repo/pricing";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  dataQualityFilterPredicates,
  dataQualitySortResolver,
  gapCondition,
} from "~/server/generic/data-quality/repo/sql";
import { relatedWhereConditions } from "~/server/generic/entity-links/repo/related-view";
import {
  ListContext,
  listPrepare,
} from "~/server/generic/list/repo/field-compiler";
import { hierarchyDescendantsSql } from "~/server/generic/list/repo/hierarchy";
import {
  listIdsCondition,
  listScaffold,
} from "~/server/generic/list/repo/list";
import {
  loadListGroup,
  wantsListGroup,
  type ListProjection,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  lexicalEligibility,
  lexicalRelevance,
} from "~/server/generic/search/repo/search-lexical";
import { resolveFilterIds } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  inventoryEntryBaseFields,
  dbInventoryEntryListValues,
} from "./mappers";

// InventoryEntry has no incoming foreign keys. Keep the empty policy explicit
// so a newly introduced reference must be classified before kernel deletion
// can remain registered.
export const INVENTORY_DELETE_EDGE_POLICY =
  {} as const satisfies IncomingEdgePolicy<"inventory", OperationDisposition>;

import {
  liveProductAndLocation,
  placementCondition,
  stockOnly,
} from "~/server/db/computed/inventory-placement";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { assertLiveTargets, inventoryAuditRow } from "./helpers";
import { dbInventoryEntryToAPI, requireLoadedProductPricing } from "./mappers";
import {
  assertIndividualOwner,
  inventoryIdsByEffectiveOwner,
  loadInventoryOwnershipTraces,
} from "./ownership";
import { applyInventoryOwnershipInTransaction } from "./ownership-mutations";
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
import {
  type InventoryValuations,
  inventoryValuationSql,
  loadInventoryValuations,
  loadLiveInventoryValuations,
} from "./valuation";

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
// update guard live targets and slot collisions.
const inventoryReader = createEntityReader({
  entity: "inventory",
  fetchById: fetchInventoryById,
  fromDB: async (db, row: InventoryEntryDeepDB) => {
    const [pricing, ownership, dataQualities, locationQualities, valuations] =
      await Promise.all([
        loadProductPricing(db, [row.product]),
        loadInventoryOwnershipTraces(db, [row]),
        loadDataQualities(db, "inventory", [row.id]),
        loadDataQualities(db, "location", [row.location.id]),
        loadInventoryValuations(db, [row]),
      ]);
    return dbInventoryEntryToAPI(
      row,
      valuations.get(row.id) ?? null,
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

// Effective-owner, ownership, and category-family filters keep their
// published schema types (`@me` resolves in the kernel before this runs).
type InventoryFilters = Pick<
  z.output<typeof inventoryFiltersSchema>,
  | "ownerLedgerPartyId"
  | "ownershipMode"
  | "categoryFeatureFilter"
  | "includeSubProductCategories"
> & {
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
  // Selected Locations plus their live descendants; `locationIdFilter` stays
  // exact because the Location detail page lists only direct stock.
  locationSubtreeFilter?:
    | LocationShortcode
    | typeof UNRESOLVABLE_ENTITY_FILTER
    | (LocationShortcode | typeof UNRESOLVABLE_ENTITY_FILTER)[];
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
};

// Amount is stored as a unit + value pair: group by unit, then by size. The
// related and valuation sorts compile from `model.derived`.
const resolveInventorySort = (sort: SortParams) => {
  const direction = sort.direction === "asc" ? asc : desc;
  if (sort.orderBy === "amount") {
    return [
      direction(inventoryEntry.amountUnit),
      direction(inventoryEntry.amountValue),
    ];
  }
  return null;
};

// One valuation map serves the rows, their sort and filter, and the footer.
const inventoryValuations = listPrepare((db) =>
  loadLiveInventoryValuations(db),
);

const inventoryScaffold = listScaffold("inventory", inventoryEntry, {
  derived: {
    valuation: inventoryValuations.value((valuations) =>
      inventoryValuationSql(valuations, inventoryEntry.id),
    ),
    valuationStatus: inventoryValuations.predicate(
      (valuations, statuses: readonly string[]) => {
        const valuation = inventoryValuationSql(valuations, inventoryEntry.id);
        return or(
          ...statuses.map((status) =>
            status === "valued"
              ? sql`${valuation} IS NOT NULL`
              : status === "missing"
                ? sql`${valuation} IS NULL`
                : and(
                    sql`${valuation} IS NULL`,
                    sql`${sql.raw(effectiveProductPriceSql('"Product"'))} IS NOT NULL`,
                  ),
          ),
        );
      },
    ),
  },
});
const inventoryScoreSort = dataQualitySortResolver("inventory", inventoryEntry);

const inventoryListOrderBy = (
  sorts: SortParams[],
  filters: InventoryFilters,
  context: ListContext,
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
      resolve: (sort) =>
        inventoryScoreSort(sort) ??
        resolveInventorySort(sort) ??
        inventoryScaffold.derivedSort(sort, context),
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
// Not `inventoryScaffold.where`: the text searches run over the JOINED product and
// location tables, not this entity's own columns, so no declared stored
// predicate can express them.
export const buildInventoryWhere = async (
  db: Database,
  filters: InventoryFilters,
  // `inventoryentryListRead` passes the context it already prepared; other
  // callers prepare what these filters read.
  prepared?: ListContext,
) => {
  // Filter-only: dashboard counts and work-queue predicates load valuations
  // only when a valuation filter asks.
  const context =
    prepared ??
    (await inventoryScaffold.context(db, { filters, readIntent: "count" }));
  const ownerCodes =
    filters.ownerLedgerPartyId === undefined
      ? undefined
      : [filters.ownerLedgerPartyId].flat();
  const [locationIds, subtreeLocationIds, productIds, ownedIds] =
    await Promise.all([
      resolveFilterIds(db, "location", filters.locationIdFilter),
      resolveFilterIds(db, "location", filters.locationSubtreeFilter),
      resolveFilterIds(db, "product", filters.productIdFilter),
      ownerCodes === undefined
        ? undefined
        : inventoryIdsByEffectiveOwner(db, ownerCodes),
    ]);
  const categoryFeatures =
    filters.categoryFeatureFilter === undefined
      ? undefined
      : [filters.categoryFeatureFilter].flat();

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
      // Stored (`ownershipMode`) and derived (`category`, `valuationStatus`)
      // filters come from the manifest; this hand-built where must apply them
      // since it bypasses `inventoryScaffold.where`.
      ...inventoryScaffold.filterPredicates(filters, context),
      listIdsCondition(inventoryEntry.shortcode, filters),
      lexicalEligibility("inventory", inventoryEntry.id, filters.searchQuery),
      eqAnyRequested(inventoryEntry.locationId, locationIds),
      subtreeLocationIds === undefined
        ? undefined
        : subtreeLocationIds.length === 0
          ? sql`false`
          : sql`${inventoryEntry.locationId} IN ${hierarchyDescendantsSql("location", subtreeLocationIds)}`,
      eqAnyRequested(inventoryEntry.productId, productIds),
      categoryFeatures === undefined
        ? undefined
        : categoryFeatureInSql(sql`${product.categoryId}`, categoryFeatures),
      ownedIds === undefined
        ? undefined
        : ownedIds.length === 0
          ? sql`false`
          : inArray(inventoryEntry.id, ownedIds),
      filters.locationRole === "global_unknown"
        ? gapCondition("inventory", "inventory_unknown_location")
        : undefined,
      filters.verifiedPresenceFilter === "has"
        ? sql`${inventoryEntry.verifiedAt} IS NOT NULL`
        : filters.verifiedPresenceFilter === "none"
          ? sql`${inventoryEntry.verifiedAt} IS NULL`
          : undefined,
      ...householdDayRangeConditions(
        inventoryEntry.verifiedAt,
        filters.verifiedFrom,
        filters.verifiedTo,
      ),
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

export const inventoryentryListRead = async (
  db: Database,
  filters: InventoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  // The rows, their sort/filter and the footer total all read ONE computed
  // map; a count-only read prepares it only for a valuation filter.
  const request = { filters, sorts, pagination, readIntent, projection };
  const context = await inventoryScaffold.context(db, request);
  const valuations = context.has(inventoryValuations)
    ? context.get(inventoryValuations)
    : undefined;
  const whereCondition = await buildInventoryWhere(db, filters, context);

  // Count-only consumers deliberately do not request table footers.
  const withSums = projection.kind === "full" && readIntent === "page";
  // Count + valuation aggregate share the joins/filters, so the footer's
  // valuation total covers the FULL filtered set (client only holds a page).
  // One query serves both: the scaffold's count reads it, the sums reuse it.
  let aggregate: ReturnType<typeof inventoryListAggregate> | undefined;
  const readAggregate = () =>
    (aggregate ??= inventoryListAggregate(
      db,
      whereCondition,
      valuations,
      withSums,
    ));

  const page = await inventoryScaffold.list(db, request, {
    context,
    where: whereCondition,
    orderBy:
      readIntent === "count"
        ? []
        : inventoryListOrderBy(sorts, filters, context),
    // A plain select, not the relational builder: the product and location
    // text filters read the joined tables.
    select: (clauses) =>
      getDb(db)
        .select({
          inventoryEntry,
          productName: product.name,
          locationName: location.name,
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
        .where(clauses.where)
        .orderBy(...clauses.orderBy)
        .limit(clauses.limit)
        .offset(clauses.offset),
    count: () => readAggregate().then((result) => result.count),
    hydrate: (results) =>
      hydrateInventoryListRows(db, results, valuations, projection),
  });
  const valuationSum = withSums
    ? Number((await readAggregate()).valuationSum ?? 0)
    : 0;
  return {
    ...page,
    sums: withSums
      ? { valuation: Number.isNaN(valuationSum) ? 0 : valuationSum }
      : undefined,
  };
};

const hydrateInventoryListRows = async (
  db: Database,
  results: Array<{
    inventoryEntry: typeof inventoryEntry.$inferSelect;
    productName: string;
    locationName: string;
  }>,
  valuations: InventoryValuations | undefined,
  projection: ListProjection,
) => {
  const entries = results.map((row) => row.inventoryEntry);
  const [ownership, dataQualities] = await Promise.all([
    loadListGroup(projection, ["relations", "derived"], () =>
      loadInventoryOwnershipTraces(db, entries),
    ),
    loadListGroup(projection, "quality", () =>
      loadDataQualities(
        db,
        "inventory",
        entries.map((row) => row.id),
      ),
    ),
  ]);
  const titleById = new Map(
    results.map((row) => [
      row.inventoryEntry.id,
      inventoryDisplayName({
        productName: row.productName,
        locationName: row.locationName,
      }),
    ]),
  );
  const coreRow = (row: (typeof entries)[number]) => ({
    ...inventoryEntryBaseFields(
      row,
      valuations?.get(row.id) ?? null,
      dataQualities?.get(row.id),
      ownership?.get(row.id),
    ),
    displayName: titleById.get(row.id),
  });
  let candidates = entries.map(coreRow);
  if (wantsListGroup(projection, "relations")) {
    const rows = entries.length
      ? await getDb(db).query.inventoryEntry.findMany({
          where: inArray(
            inventoryEntry.id,
            entries.map((row) => row.id),
          ),
          ...relations.inventory.list,
        })
      : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = entries.flatMap((row) => {
      const found = byId.get(row.id);
      return found ? [found] : [];
    });
    const pricing = await loadProductPricing(
      db,
      ordered.map((entry) => entry.product),
    );
    candidates = ordered.map((row) =>
      dbInventoryEntryListValues(
        row,
        valuations?.get(row.id) ?? null,
        requireLoadedProductPricing(pricing, row.product.id),
        dataQualities?.get(row.id),
        ownership?.get(row.id),
      ),
    );
  }
  const candidatesByCode = new Map(candidates.map((row) => [row.id, row]));
  const mapped = wantsListGroup(projection, "media")
    ? await withDisplayImages(db, "inventory", entries, (row) =>
        candidatesByCode.get(
          inventoryEntryBaseFields(row, null, undefined).id,
        )!,
      )
    : candidates;
  return projectListRows("inventory", mapped, projection);
};

const inventoryListAggregate = async (
  db: Database,
  where: Awaited<ReturnType<typeof buildInventoryWhere>>,
  valuations: InventoryValuations | undefined,
  includeSummary: boolean,
) => {
  const [result] = await getDb(db)
    .select({
      count: count(),
      valuationSum:
        includeSummary && valuations
          ? sum(inventoryValuationSql(valuations, inventoryEntry.id))
          : sql<number>`0`,
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
    .where(where);
  return result ?? { count: 0, valuationSum: 0 };
};
export const inventoryentryListSummary = async (
  db: Database,
  filters: InventoryFilters,
) => {
  // The footer total reads every filtered row's valuation.
  const context = await inventoryScaffold.context(db, {
    filters,
    projection: { kind: "full" },
  });
  const valuations = context.get(inventoryValuations);
  const where = await buildInventoryWhere(db, filters, context);
  const result = await inventoryListAggregate(db, where, valuations, true);
  const value = Number(result.valuationSum ?? 0);
  return { valuation: Number.isNaN(value) ? 0 : value };
};
export const inventoryentryList = completeListReader(
  inventoryListItemOut,
  inventoryentryListRead,
);

type InventoryRow = typeof inventoryEntry.$inferSelect;

const resolveUpdatedOwnership = (
  before: InventoryRow,
  data: UpdateInventoryEntryData,
): InventoryRawOwnership => ({
  // Picking an owner sets it here; clearing one goes back to inheriting.
  ownershipMode:
    data.ownershipMode ??
    (data.ownerLedgerPartyId === undefined
      ? before.ownershipMode
      : data.ownerLedgerPartyId === null
        ? "inherit"
        : "explicit"),
  ownerLedgerPartyId:
    data.ownerLedgerPartyId !== undefined
      ? data.ownerLedgerPartyId
      : data.ownershipMode === "inherit"
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
      "Inherited ownership cannot retain an owner.",
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

const isOwnershipOnlyUpdate = (data: UpdateInventoryEntryData) =>
  Object.entries(data).every(
    ([key, value]) =>
      value === undefined ||
      key === "ownershipMode" ||
      key === "ownerLedgerPartyId",
  ) &&
  (data.ownershipMode !== undefined || data.ownerLedgerPartyId !== undefined);

const hydrateUpdatedInventoryEntry = async (db: Database, id: InventoryId) => {
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw createAppError(
      "INVENTORY_NOT_FOUND",
      `Inventory entry ${id} not found after update`,
    );
  }

  const [pricing, ownership, dataQualities, locationQualities, valuations] =
    await Promise.all([
      loadProductPricing(db, [result.product]),
      loadInventoryOwnershipTraces(db, [result]),
      loadDataQualities(db, "inventory", [result.id]),
      loadDataQualities(db, "location", [result.location.id]),
      loadInventoryValuations(db, [result]),
    ]);
  // SAFETY: `result` was just fetched live by id, so its quality was evaluated.
  return dbInventoryEntryToAPI(
    result,
    valuations.get(result.id) ?? null,
    requireLoadedProductPricing(pricing, result.product.id),
    dataQualities.get(result.id)!,
    locationQualities.get(result.location.id)!,
    ownership.get(result.id),
  );
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

  // An ownership-only patch (the shared Confirm / Use inherited / None
  // actions) folds into an existing entry with that ownership instead of
  // refusing the occupied slot, exactly as `setOwnership` does.
  if (isOwnershipOnlyUpdate(data)) {
    const [survivor] = await withTransaction(db, (tx) =>
      applyInventoryOwnershipInTransaction(
        tx,
        id,
        rawOwnership,
        undefined,
        actor,
      ),
    );
    if (!survivor)
      throw createAppError(
        "INVENTORY_NOT_FOUND",
        `Inventory entry ${id} not found after update`,
      );
    return await hydrateUpdatedInventoryEntry(db, survivor);
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
  await assertUpdatedSlotAvailable(db, id, before, data, rawOwnership);

  const amountColumns =
    data.amount === undefined ? undefined : amountToColumns(data.amount);
  const updateValues = buildPartialUpdateValues({
    amountValue: amountColumns?.amountValue,
    amountUnit: amountColumns?.amountUnit,
    productId: data.productId,
    locationId: data.locationId,
    // Flipping placement is how something becomes (or stops being) a fixture.
    // It does NOT move the row — the dimmer stays in the kitchen, it just stops
    // being counted, audited, and browsed.
    placement: data.placement,
    // Either ownership field writes both, so an owner picked alongside other
    // edits still implies explicit (and a cleared one, inherit).
    ...(data.ownershipMode !== undefined ||
    data.ownerLedgerPartyId !== undefined
      ? rawOwnership
      : {}),
  });

  const updated = await updateLiveAndReturn(
    db,
    inventoryEntry,
    updateValues,
    id,
  );

  if (before) {
    const changes = computeChanges(
      inventoryAuditRow(before),
      inventoryAuditRow(updated),
      [...entityFieldModels.inventory.audit],
    );
    if (changes) {
      await logAuditEntry(db, actor, {
        entityKind: "inventory",
        entityId: id,
        action: "update",
        changes,
      });
    }
  }

  return await hydrateUpdatedInventoryEntry(db, updated.id);
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

  const ownershipMode =
    data.ownershipMode ?? (data.ownerLedgerPartyId ? "explicit" : "inherit");
  const ownerLedgerPartyId = data.ownerLedgerPartyId ?? null;
  try {
    assertValidRawInventoryOwnership({ ownershipMode, ownerLedgerPartyId });
  } catch {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Inherited ownership cannot retain an owner.",
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
    ...amountToColumns(data.amount),
    ownershipMode,
    ownerLedgerPartyId,
  };
  if (data.placement) values.placement = data.placement;
  if (data.verifiedAt) values.verifiedAt = data.verifiedAt;
  const created = await insertWithShortcode(db, "inventory", values);

  await logAuditEntry(db, actor, {
    entityKind: "inventory",
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

  const [pricing, ownership, dataQualities, locationQualities, valuations] =
    await Promise.all([
      loadProductPricing(db, [result.product]),
      loadInventoryOwnershipTraces(db, [result]),
      loadDataQualities(db, "inventory", [result.id]),
      loadDataQualities(db, "location", [result.location.id]),
      loadInventoryValuations(db, [result]),
    ]);
  // SAFETY: `result` was just fetched live by id, so its quality was evaluated.
  return dbInventoryEntryToAPI(
    result,
    valuations.get(result.id) ?? null,
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

  const [pricing, ownership, dataQualities, locationQualities, valuations] =
    await Promise.all([
      loadProductPricing(
        db,
        results.map((entry) => entry.product),
      ),
      loadInventoryOwnershipTraces(db, results),
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
      loadInventoryValuations(db, results),
    ]);
  return results.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      valuations.get(entry.id) ?? null,
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
    columns: { productId: true, amountValue: true, amountUnit: true },
  });

  return rows.map((row) => ({
    productId: row.productId,
    amount: amountFromColumns(row),
  }));
};

/** Inventory deletes take uuids; no incoming edge outlives an entry. */
export const deleteInventoryEntries = (
  db: Database,
  ids: InventoryId[],
  actor: ActorContext,
) =>
  deleteByPolicy(db, {
    entity: "inventory",
    policy: INVENTORY_DELETE_EDGE_POLICY,
    ids,
    actor,
  });

import type { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";

import { withDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";

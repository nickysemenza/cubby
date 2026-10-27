import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { inventoryDisplayName } from "@cubby/schemas/inventory";
import type {
  InventoryPlacement,
  inventoryFiltersSchema,
} from "@cubby/schemas/inventory";
import { inventoryValuationStatus } from "@cubby/schemas/inventory-fields";
import { rawInventoryList } from "@cubby/schemas/inventory-raw-read";
import {
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  and,
  asc,
  getTableColumns,
  count,
  desc,
  eq,
  inArray,
  not,
  sql,
  sum,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  amountFromColumns,
  parseInventoryAmount,
  amountToColumns,
  buildOrderBy,
  buildPartialUpdateValues,
  getDb,
  type ListReadIntent,
  notDeleted,
  relations,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { inventoryEntry, location, product } from "~/server/db/schema";
import { parseLocationType } from "~/server/domains/location/repo/parse-type";
import {
  mapDbProductToInventoryList,
  primaryGtinOf,
} from "~/server/domains/product/repo/mappers";
import {
  effectiveProductPriceSql,
  loadProductPricing,
  storedEffectivePrice,
} from "~/server/domains/product/repo/pricing";
import { resolveEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import {
  type MutationReceipt,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createEntityReader } from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import {
  dataQualitySortResolver,
  gapCondition,
} from "~/server/generic/data-quality/repo/sql";
import {
  loadStoredDerived,
  storedDerivedSql,
} from "~/server/generic/derived/repo/read";
import {
  type AnyOfValue,
  ListContext,
  sharedListPrepare,
} from "~/server/generic/list/repo/field-compiler";
import { listScaffold } from "~/server/generic/list/repo/list";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import { lexicalRelevance } from "~/server/generic/search/repo/search-lexical";

import { inventoryEntryOwnershipFields } from "./mappers";

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
import {
  assertValidRawInventoryOwnership,
  inventoryOwnershipSlotCondition,
  type InventoryRawOwnership,
} from "~/server/domains/inventory/repo/slot";
import type {
  CreateInventoryEntryData,
  InventoryEntryDeepDB,
  UpdateInventoryEntryData,
} from "~/server/domains/inventory/repo/types";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { assertLiveTargets, inventoryAuditRow } from "./helpers";
import { dbInventoryEntryToAPI, requireLoadedProductPricing } from "./mappers";
import {
  assertIndividualOwner,
  loadInventoryOwnerStates,
  loadInventoryOwnershipTraces,
  selectInventoryIdsByOwner,
} from "./ownership";
import { applyInventoryOwnershipInTransaction } from "./ownership-mutations";
import { loadStoredInventoryValuations } from "./valuation";

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
    const [pricing, ownership, dataQualities, valuations, productImages] =
      await Promise.all([
        loadProductPricing(db, [row.product]),
        loadInventoryOwnershipTraces(db, [row]),
        loadDataQualities(db, "inventory", [row.id]),

        loadStoredInventoryValuations(db, [row.id]),
        resolveEntityDisplayImageLists(
          db,
          [row].map((entry) => ({
            entityKind: "product",
            entityId: entry.product.id,
          })),
        ),
      ]);
    return dbInventoryEntryToAPI(
      row,
      valuations.get(row.id) ?? null,
      requireLoadedProductPricing(pricing, row.product.id),
      // SAFETY: `row` was just fetched live by id, so its quality was evaluated.
      dataQualities.get(row.id)!,
      ownership.get(row.id),
      productImages.get(entityRefKey("product", row.product.id)) ?? [],
    );
  },
});

export const getInventoryEntryByShortcode = (db: Database, shortcode: string) =>
  inventoryReader.getByShortcode(db, shortcode);

type InventoryFilters = z.output<typeof inventoryFiltersSchema> & {
  searchQuery?: string;
};

/** The stored valuation (ADR 0021): rows, sort, filter and footer read one figure. */
const storedValuation = storedDerivedSql(
  "inventory",
  "valuation",
  inventoryEntry.id,
);

// The ownership resolver runs once per request, only when it filters by owner.
const effectiveOwners = sharedListPrepare(loadInventoryOwnerStates);

const inventoryScaffold = listScaffold("inventory", inventoryEntry, {
  population: liveProductAndLocation,
  derived: {
    effectiveOwner: effectiveOwners.predicate<AnyOfValue>((states, value) => {
      const ids = selectInventoryIdsByOwner(states, value.values);
      return ids.length === 0 ? sql`false` : inArray(inventoryEntry.id, ids);
    }),
    locationRole: gapCondition("inventory", "inventory_unknown_location"),
    valuation: storedValuation,
    // Amount is stored as a unit + value pair: group by unit, then by size.
    amount: [
      sql`${inventoryEntry.amountUnit}`,
      sql`${inventoryEntry.amountValue}`,
    ],
    valuationStatus: sql`CASE
        WHEN ${storedValuation} IS NOT NULL THEN ${inventoryValuationStatus.enum.valued}::text
        WHEN (SELECT ${sql.raw(effectiveProductPriceSql("vs_p"))} FROM "Product" vs_p WHERE vs_p."id" = ${inventoryEntry.productId}) IS NOT NULL THEN ${inventoryValuationStatus.enum.priceable}::text
        ELSE ${inventoryValuationStatus.enum.unpriceable}::text END`,
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
 * `INNER JOIN`s the list reads: rows, count, and the valuation aggregate all
 * narrow the same way, and a caller with no joins gets the same population.
 */
export const buildInventoryWhere = async (
  db: Database,
  filters: InventoryFilters,
  // `inventoryentryListRead` passes the context it already prepared; other
  // callers prepare what these filters read.
  prepared?: ListContext,
) => {
  // Filter-only: dashboard counts and work-queue predicates load valuations
  // and owners only when a filter asks.
  const context =
    prepared ??
    (await inventoryScaffold.context(db, { filters, readIntent: "count" }));
  return inventoryScaffold.where(filters, { context });
};

export const inventoryentryListRead = async (
  db: Database,
  filters: InventoryFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection,
  readIntent: ListReadIntent = "page",
) => {
  const request = { filters, sorts, pagination, readIntent, projection };
  const context = await inventoryScaffold.context(db, request);
  const whereCondition = await buildInventoryWhere(db, filters, context);

  // Count-only consumers deliberately do not request table footers.
  const withSums = projection.kind === "full" && readIntent === "page";
  // Count + valuation aggregate share the joins/filters, so the footer's
  // valuation total covers the FULL filtered set (client only holds a page).
  // One query serves both: the scaffold's count reads it, the sums reuse it.
  let aggregate: ReturnType<typeof inventoryListAggregate> | undefined;
  const readAggregate = () =>
    (aggregate ??= inventoryListAggregate(db, whereCondition, withSums));

  const page = await inventoryScaffold.read(db, request, {
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
          ...getTableColumns(inventoryEntry),
          productName: product.name,
          locationName: location.name,
          valuation: sql<number | null>`${storedValuation}`,
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
    joins: (query) =>
      query
        .innerJoin(
          product,
          and(eq(inventoryEntry.productId, product.id), notDeleted(product)),
        )
        .innerJoin(
          location,
          and(eq(inventoryEntry.locationId, location.id), notDeleted(location)),
        ),
    read: {
      media: true,
      bindings: (bind) => {
        const ownership = bind.batch(({ rows }) =>
          loadInventoryOwnershipTraces(db, rows),
        );
        const references = bind.batch(async ({ rows }) => {
          const [related, prices] = await Promise.all([
            getDb(db).query.inventoryEntry.findMany({
              where: inArray(
                inventoryEntry.id,
                rows.map((row) => row.id),
              ),
              ...relations.inventory.list,
            }),
            loadStoredDerived(
              db,
              "product",
              [...new Set(rows.map((row) => row.productId))],
              ["price"],
            ),
          ]);
          return {
            byId: new Map(related.map((row) => [row.id, row])),
            prices,
          };
        });
        return [
          bind(rawInventoryList.pick({ amount: true }), (row) => ({
            amount: parseInventoryAmount(row),
          })),
          bind(rawInventoryList.pick({ displayName: true }), (row) => ({
            displayName: inventoryDisplayName({
              productName: row.productName,
              locationName: row.locationName,
            }),
          })),
          bind(rawInventoryList.pick({ valuation: true }), (row) => ({
            valuation: row.valuation,
          })),
          ownership.fields(
            rawInventoryList.pick({
              ownerLedgerPartyId: true,
              effectiveOwnership: true,
              fieldResolutions: true,
            }),
            (row, loaded) => {
              const trace = loaded.get(row.id);
              if (!trace)
                throw new Error("Inventory ownership trace was not loaded");
              return inventoryEntryOwnershipFields(trace);
            },
          ),
          references.fields(
            rawInventoryList.pick({
              product: true,
              location: true,
              locationId: true,
            }),
            (row, loaded) => {
              const entry = loaded.byId.get(row.id);
              if (!entry)
                throw new Error(
                  "Inventory product/location references were not loaded",
                );
              return {
                locationId: parseShortcodeFor(
                  "location",
                  entry.location.shortcode,
                ),
                location: {
                  id: parseShortcodeFor("location", entry.location.shortcode),
                  name: entry.location.name,
                  type: parseLocationType(entry.location.type),
                },
                product: mapDbProductToInventoryList({
                  ...entry.product,
                  effectivePrice: storedEffectivePrice(
                    loaded.prices,
                    entry.product,
                  ),
                  primaryGtin: primaryGtinOf(entry.product.externalIds),
                }),
              };
            },
          ),
        ];
      },
    },
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

const inventoryListAggregate = async (
  db: Database,
  where: Awaited<ReturnType<typeof buildInventoryWhere>>,
  includeSummary: boolean,
) => {
  const [result] = await getDb(db)
    .select({
      count: count(),
      valuationSum: includeSummary ? sum(storedValuation) : sql<number>`0`,
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
  // The footer total reads every filtered row's stored valuation.
  const where = await buildInventoryWhere(db, filters);
  const result = await inventoryListAggregate(db, where, true);
  const value = Number(result.valuationSum ?? 0);
  return { valuation: Number.isNaN(value) ? 0 : value };
};
export const inventoryentryList = completeListReader(
  rawInventoryList,
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

const hydrateInventoryEntry = async (
  db: Database,
  id: InventoryId,
  after: "creation" | "update",
) => {
  const result = await getDb(db).query.inventoryEntry.findFirst({
    where: eq(inventoryEntry.id, id),
    ...relations.inventory.full,
  });

  if (!result) {
    throw createAppError(
      "INVENTORY_NOT_FOUND",
      `Inventory entry ${id} not found after ${after}`,
    );
  }

  const [pricing, ownership, dataQualities, valuations, productImages] =
    await Promise.all([
      loadProductPricing(db, [result.product]),
      loadInventoryOwnershipTraces(db, [result]),
      loadDataQualities(db, "inventory", [result.id]),

      loadStoredInventoryValuations(db, [result.id]),
      resolveEntityDisplayImageLists(
        db,
        [result].map((entry) => ({
          entityKind: "product",
          entityId: entry.product.id,
        })),
      ),
    ]);
  // SAFETY: `result` was just fetched live by id, so its quality was evaluated.
  return dbInventoryEntryToAPI(
    result,
    valuations.get(result.id) ?? null,
    requireLoadedProductPricing(pricing, result.product.id),
    dataQualities.get(result.id)!,
    ownership.get(result.id),
    productImages.get(entityRefKey("product", result.product.id)) ?? [],
  );
};

export const updateInventoryEntry = defineMutationWriter({
  entity: "inventory",
  read: (
    receipt: MutationReceipt<"inventory">,
    db: Database,
    _id: InventoryId,
    _data: UpdateInventoryEntryData,
    _actor: ActorContext,
  ) => hydrateInventoryEntry(db, receipt.entityId, "update"),
  write: async (
    readOutput,
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
      return readOutput({ entityId: survivor });
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

    return readOutput({ entityId: updated.id, shortcode: updated.shortcode });
  },
});

/** Validate, insert and audit one entry, returning its stored identity. */
export const insertInventoryEntry = async (
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

  return { id: created.id, shortcode: created.shortcode };
};

/** Create and return the API entry; identity-only callers use `insertInventoryEntry`. */
export const createInventoryEntry = defineMutationWriter({
  entity: "inventory",
  read: (
    receipt: MutationReceipt<"inventory">,
    db: Database,
    _data: CreateInventoryEntryData,
    _actor: ActorContext,
  ) => hydrateInventoryEntry(db, receipt.entityId, "creation"),
  write: async (
    readOutput,
    db: Database,
    data: CreateInventoryEntryData,
    actor: ActorContext,
  ) => {
    const created = await insertInventoryEntry(db, data, actor);
    return readOutput({ entityId: created.id, shortcode: created.shortcode });
  },
});

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

  const [pricing, ownership, dataQualities, valuations, productImages] =
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

      loadStoredInventoryValuations(
        db,
        results.map((row) => row.id),
      ),
      resolveEntityDisplayImageLists(
        db,
        results.map((entry) => ({
          entityKind: "product",
          entityId: entry.product.id,
        })),
      ),
    ]);
  return results.map((entry) =>
    dbInventoryEntryToAPI(
      entry,
      valuations.get(entry.id) ?? null,
      requireLoadedProductPricing(pricing, entry.product.id),
      // SAFETY: `entry` came from `results`, whose Inventory quality was loaded.
      dataQualities.get(entry.id)!,
      ownership.get(entry.id),
      productImages.get(entityRefKey("product", entry.product.id)) ?? [],
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

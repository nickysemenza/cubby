import type { Amount } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type {
  InventoryId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import { inventoryDisplayName } from "@cubby/schemas/inventory";
import type { InventoryPlacement } from "@cubby/schemas/inventory";
import { inventoryValuationStatus } from "@cubby/schemas/inventory-fields";
import {
  rawInventoryDetail,
  rawInventoryList,
} from "@cubby/schemas/inventory-raw-read";
import { and, eq, inArray, not, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  liveProductAndLocation,
  placementCondition,
  stockOnly,
} from "~/server/db/computed/inventory-placement";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  amountFromColumns,
  parseInventoryAmount,
  amountToColumns,
  buildPartialUpdateValues,
  getDb,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { inventoryEntry, product } from "~/server/db/schema";
import { inventorySearch } from "~/server/domains/inventory/repo/search-read-inventory";
import {
  assertValidRawInventoryOwnership,
  inventoryOwnershipSlotCondition,
  type InventoryRawOwnership,
} from "~/server/domains/inventory/repo/slot";
import type {
  CreateInventoryEntryData,
  UpdateInventoryEntryData,
} from "~/server/domains/inventory/repo/types";
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
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { gapCondition } from "~/server/generic/data-quality/repo/sql";
import {
  loadStoredDerived,
  storedDerivedSql,
} from "~/server/generic/derived/repo/read";
import { listScaffold } from "~/server/generic/list/repo/list";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { assertLiveTargets, inventoryAuditRow } from "./helpers";
import {
  inventoryDetailProduct,
  inventoryEntryOwnershipFields,
  requireLoadedProductPricing,
} from "./mappers";
import {
  assertIndividualOwner,
  inventoryOwnerFilterSql,
  loadStoredInventoryOwnershipTraces,
} from "./ownership";
import { applyInventoryOwnershipInTransaction } from "./ownership-mutations";

// InventoryEntry has no incoming foreign keys. Keep the empty policy explicit
// so a newly introduced reference must be classified before kernel deletion
// can remain registered.
export const INVENTORY_DELETE_EDGE_POLICY =
  {} as const satisfies IncomingEdgePolicy<"inventory", OperationDisposition>;

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

/** The stored valuation (ADR 0021): rows, sort, filter and totals read one figure. */
const storedValuation = storedDerivedSql(
  "inventory",
  "valuation",
  inventoryEntry.id,
);

// The ownership resolver runs once per request, only when it filters by owner.

/** The declared read's row: stored columns plus the names `displayName` reads. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- matches listScaffold's default Row; bindings read declared keys by name.
type InventoryReadRow = typeof inventoryEntry.$inferSelect & {
  readonly productName: string;
  readonly locationName: string;
  readonly [key: string]: unknown;
};

/**
 * The Inventory read, stated once: list pages, selected projections, totals
 * and the single-record read all select through it. {@link liveProductAndLocation}
 * is the population: rows, counts and totals narrow to live products and
 * locations without joining them.
 */
export const inventoryScaffold = listScaffold<
  "inventory",
  typeof inventoryEntry,
  InventoryReadRow
>("inventory", inventoryEntry, {
  population: liveProductAndLocation,
  derived: {
    effectiveOwner: (value) =>
      value.values.length === 0
        ? sql`false`
        : sql`${inventoryOwnerFilterSql()} IN (${sql.join(
            value.values.map((owner) => sql`${owner}`),
            sql`, `,
          )})`,
    locationRole: gapCondition(
      "inventory",
      "inventory_unknown_location",
      inventoryEntry,
    ),
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
  read: {
    title: sql<string>`(SELECT p."name" || CASE WHEN l."name" IS NOT NULL THEN ' · ' || l."name" ELSE '' END FROM "Product" p INNER JOIN "Location" l ON l."id" = "InventoryEntry"."locationId" WHERE p."id" = "InventoryEntry"."productId")`,
    search: inventorySearch,
    columns: {
      productName: sql<string>`(SELECT p."name" FROM "Product" p WHERE p."id" = ${inventoryEntry.productId})`,
      locationName: sql<string>`(SELECT l."name" FROM "Location" l WHERE l."id" = ${inventoryEntry.locationId})`,
    },
    media: true,
    tieBreaker: sql`${inventoryEntry.createdAt} desc`,
    bindings: (bind) => {
      const inventoryIds = (ids: readonly string[]) =>
        ids.map((id) => parseEntityId("inventory", id));
      const ownership = bind.batch(({ db, rows }) =>
        loadStoredInventoryOwnershipTraces(db, rows),
      );
      const references = bind.ids(async ({ db, ids }) => {
        const related = await unwrapDb(db).query.inventoryEntry.findMany({
          where: inArray(inventoryEntry.id, inventoryIds(ids)),
          ...relations.inventory.list,
        });
        const prices = await loadStoredDerived(
          db,
          "product",
          [...new Set(related.map((row) => row.productId))],
          ["price"],
        );
        return { byId: new Map(related.map((row) => [row.id, row])), prices };
      });
      // A record read embeds the full product: gallery, identifiers, unit
      // mappings and its display images, priced live.
      const products = bind.ids(async ({ db, ids }) => {
        const related = await unwrapDb(db).query.inventoryEntry.findMany({
          where: inArray(inventoryEntry.id, inventoryIds(ids)),
          ...relations.inventory.full,
        });
        const [pricing, images] = await Promise.all([
          loadProductPricing(
            db,
            related.map((entry) => entry.product),
          ),
          resolveEntityDisplayImageLists(
            db,
            related.map((entry) => ({
              entityKind: "product" as const,
              entityId: entry.product.id,
            })),
          ),
        ]);
        return {
          byId: new Map(related.map((row) => [row.id, row])),
          pricing,
          images,
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
        // Owner and trace are stored projections the plan binds generically; a
        // page shows no resolution, a record read explains the stored owner.
        bind(rawInventoryList.pick({ fieldResolutions: true }), () => ({
          fieldResolutions: {},
        })),
        ownership.fields(
          rawInventoryList.pick({ fieldResolutions: true }),
          (row, loaded) => {
            const trace = loaded.get(row.id);
            return {
              fieldResolutions: trace
                ? inventoryEntryOwnershipFields(trace).fieldResolutions
                : {},
            };
          },
          { scope: "detail" },
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
        products.fields(
          rawInventoryDetail.pick({ product: true }),
          (row, loaded) => {
            const entry = loaded.byId.get(row.id);
            if (!entry) throw new Error("Inventory product was not loaded");
            return {
              product: inventoryDetailProduct(
                entry.product,
                requireLoadedProductPricing(loaded.pricing, entry.product.id),
                loaded.images.get(entityRefKey("product", entry.product.id)) ??
                  [],
              ),
            };
          },
          { scope: "detail" },
        ),
      ];
    },
  },
});

const inventoryReader = createEntityReader({
  entity: "inventory",
  scaffold: inventoryScaffold,
  output: rawInventoryDetail,
});
/** One live Inventory entry by internal id; throws `INVENTORY_NOT_FOUND`. */
const readInventoryById = inventoryReader.getByID;
/** One live Inventory entry by public code, or null. */
export const readInventory = inventoryReader.getByShortcode;
/** Live Inventory entries by internal id through the declared read, in id order. */
export const readInventoryEntries = async (
  db: Database | DrizzleTransaction,
  ids: readonly InventoryId[],
) => {
  const { data } = await inventoryScaffold.getByIds(db, ids);
  return data.map((row) => rawInventoryDetail.parse(row));
};

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

export const updateInventoryEntry = defineMutationWriter({
  entity: "inventory",
  read: (
    receipt: MutationReceipt<"inventory">,
    db: Database,
    _id: InventoryId,
    _data: UpdateInventoryEntryData,
    _actor: ActorContext,
  ) => readInventoryById(db, receipt.entityId),
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
  ) => readInventoryById(db, receipt.entityId),
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
 * Inventory entries at these locations through the declared read.
 *
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
  const rows = await getDb(db)
    .select({ id: inventoryEntry.id })
    .from(inventoryEntry)
    .where(
      and(
        notDeleted(inventoryEntry),
        placementCondition(options.placement ?? "all"),
        inArray(inventoryEntry.locationId, locationIds),
      ),
    );
  return readInventoryEntries(
    db,
    rows.map((row) => row.id),
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

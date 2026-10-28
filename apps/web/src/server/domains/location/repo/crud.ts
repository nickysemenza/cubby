import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type LocationId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { RawImageOutput } from "@cubby/schemas/image-raw-read";
import { preferredImageUrl } from "@cubby/schemas/image-summary";
import {
  locationPickerAncestorOut,
  locationPickerItemOut,
} from "@cubby/schemas/location";
import type {
  LocationCreateInput,
  LocationPickerItemOut,
  LocationUpdateInput,
} from "@cubby/schemas/location";
import { locationPickerSortableFields } from "@cubby/schemas/location";
import { locationValuation } from "@cubby/schemas/location-fields";
import {
  type RawLocationDetail,
  rawLocationDetail,
  rawLocationList,
} from "@cubby/schemas/location-raw-read";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import { getR2PublicUrl } from "~/server/clients/r2-public-url";
import type { Database, DrizzleTransaction } from "~/server/db";
import { stockOnly } from "~/server/db/computed/inventory-placement";
import {
  LOCATION_DESCRIPTION_FEATURE_ID,
  locationAiDescriptionSql,
} from "~/server/db/computed/location-ai-description";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  associatePendingImages,
  buildOrderBy,
  buildPartialUpdateValues,
  getDb,
  galleryBinding,
  mapImages,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
  withTransactionOn,
} from "~/server/db/helpers";
import { outer } from "~/server/db/helpers/related";
import {
  aiAnalysis,
  derivedValue,
  entityAttachment,
  image,
  inventoryEntry,
  location,
  product,
} from "~/server/db/schema";
import { syncEntityImages } from "~/server/domains/image/repo/entity-image-sync";
import { displayableImageWhere } from "~/server/domains/image/repo/image-displayability";
import { hydrateImageReadProjection } from "~/server/domains/image/repo/image-read-projection";
import { getHomeLocation } from "~/server/domains/location/repo/home";
import { mapLocationIdentityProduct } from "~/server/domains/location/repo/identity-product";
import type {
  LocationFilters,
  LocationWithParentChild,
} from "~/server/domains/location/repo/internal-types";
import { parseLocationType } from "~/server/domains/location/repo/parse-type";
import { locationSearch as locationSearchRead } from "~/server/domains/location/repo/search-read-location";
import { assertClassificationPolicies } from "~/server/domains/spending-category/repo/classification-field-policy";
import {
  resolveEntityDisplayImages,
  resolveEntityDisplayImageLists,
} from "~/server/entity-kernel/repo/entity-display-image";
import {
  type MutationReceipt,
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  isUniqueViolation,
  type UnparsedDatabaseError,
} from "~/server/errors/db-errors";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { loadDataQualities } from "~/server/generic/data-quality/repo/hydrate";
import { publicFieldEnvelopeBatch } from "~/server/generic/derived/repo/public-read";
import { storedDerivedSql } from "~/server/generic/derived/repo/read";
import { listScaffold } from "~/server/generic/list/repo/list";
import { valuationLabel } from "~/server/generic/list/repo/list-display-labels";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllPresent,
  resolveLiveShortcode,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { liveAliasSqlText } from "~/server/lib/live-row";

import {
  buildLocationWithChildren,
  locationReferenceFields,
  locationInventoryFields,
} from "./helpers";
import { loadStockItemsByLocation } from "./stock-items";
import { loadLocationAncestors, wouldCreateParentCycle } from "./tree";
import { loadStoredLocationValuations } from "./valuation";

export const LOCATION_DELETE_EDGE_POLICY = {
  "InventoryEntry.locationId": {
    code: "block-live-inventory",
    effect: "block",
    description:
      "A location still holding inventory can't be deleted — move or remove the inventory first.",
  },
  "EntityAttachment.entityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the location, and each file is\n      deleted too unless something else still references it.",
  },
  "Location.parentId": {
    code: "promote-live-child",
    effect: "detach",
    description:
      "A deleted location's children are promoted to its nearest surviving ancestor rather than the deletion being blocked.",
  },
  "PhotoGroupProposal.inventoryLocationId": {
    code: "clear-proposal-location",
    effect: "detach",
    description:
      "Deleting a location clears a photo group proposal's inventory location; a proposed group must then pick another before approval.",
  },
  "Planting.locationId": {
    code: "block-live-planting",
    effect: "block",
    description:
      "A location named by a current or planned planting cannot be deleted.",
  },
  "GardenEntry.locationId": {
    code: "block-garden-history",
    effect: "block",
    description: "A location with dated garden observations cannot be deleted.",
  },
} as const satisfies IncomingEdgePolicy<"location", OperationDisposition>;

/**
 * Turn a `Location_name_key` violation into an error that names the blocker.
 *
 * Locations have no duplicate pre-check — uniqueness comes solely from the
 * partial functional index on `lower(name)` — so a collision used to reach the
 * generic Postgres translator and come back as "A location with these details
 * already exists." Not even the offending column: `columnsFromDetail` reads
 * `Key (...)=` with a character class that cannot cross the inner paren of
 * `Key (lower(name))=(ppe)`, so it matched nothing and fell to the vaguest
 * branch. The name is right there in the caller's input; what is missing is
 * *which* location already holds it, which is the thing you need to go look at.
 *
 * No-op if the error isn't a unique violation, so callers rethrow.
 */
const throwIfDuplicateLocation = async (
  db: Database,
  name: string,
  error: UnparsedDatabaseError,
): Promise<void> => {
  if (!isUniqueViolation(error, "Location_name_key")) return;
  // `lower(name) = lower($1)` rather than ilike, so the planner uses the same
  // functional index that raised the violation (see findOrCreateLocationByName).
  const existing = await unwrapDb(db).query.location.findFirst({
    where: and(
      sql`lower(${location.name}) = lower(${name})`,
      notDeleted(location),
    ),
    columns: { name: true, shortcode: true },
  });
  throw createAppError(
    "DUPLICATE_RECORD",
    existing
      ? `A location named “${existing.name}” already exists: ${existing.shortcode}.`
      : `A location named “${name}” already exists.`,
    error,
  );
};

export const createLocation = async (
  db: Database,
  data: LocationCreateInput,
  actor: ActorContext,
) => (await createLocationRecord(db, data, actor)).output;

/** `createLocation` with the inserted row's id, so a caller never re-resolves the code it just minted. */
export const createLocationRecord = defineMutationWriter({
  entity: "location",
  read: async (
    receipt: MutationReceipt<"location">,
    db: Database,
    _data: LocationCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await readLocationById(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: LocationCreateInput,
    actor: ActorContext,
  ) => {
    try {
      return await createLocationTx.withOutput(readOutput, db, data, actor);
    } catch (error) {
      // Safe on a clean connection: withTransaction has already rolled back.
      await throwIfDuplicateLocation(db, data.name, error);
      throw error;
    }
  },
});

/**
 * A caller-supplied product code that does not resolve is bad input, not a
 * missing page — `REFERENCED_RECORD_MISSING` rather than `PRODUCT_NOT_FOUND`.
 */
const raiseMissingProduct = (): never => {
  throw createAppError(
    "REFERENCED_RECORD_MISSING",
    "Cannot set product: the specified product does not exist",
  );
};

/**
 * A location with no Product to be an instance of has no form factor unless the
 * caller names one, and `type` is NOT NULL.
 */
const raiseMissingType = (): never => {
  throw createAppError(
    "CONSTRAINT_VIOLATION",
    "A location needs a type unless it is an instance of a Product (which is stored as furniture).",
  );
};

const createLocationTx = defineMutationWriter({
  entity: "location",
  read: async (
    receipt: MutationReceipt<"location">,
    db: Database,
    _data: LocationCreateInput,
    _actor: ActorContext,
  ) => ({
    output: await readLocationById(db, receipt.entityId),
    entityId: receipt.entityId,
  }),
  write: async (
    readOutput,
    db: Database,
    data: LocationCreateInput,
    actor: ActorContext,
  ) => {
    return await withTransaction(db, async (tx) => {
      let parentId: LocationId;
      if (data.parentId) {
        const resolvedParent = await resolveLiveShortcode(
          tx,
          data.parentId,
          "location",
        );
        if (!resolvedParent) {
          throw createAppError(
            "REFERENCED_RECORD_MISSING",
            "Cannot set parent: the specified parent location does not exist",
          );
        }
        parentId = parseEntityId("location", resolvedParent);
      } else {
        parentId = (await getHomeLocation(tx)).id;
      }
      // A miss here is a validation failure on caller-supplied input, not a 404
      // for the location being created — hence the raw resolve rather than
      // `resolveOrThrow`.
      const productId = data.productId
        ? parseEntityId(
            "product",
            (await resolveLiveShortcode(tx, data.productId, "product")) ??
              raiseMissingProduct(),
          )
        : null;
      const type = data.type ?? (productId ? "furniture" : raiseMissingType());
      assertClassificationPolicies("location", { type, productId });
      const newLocation = await insertWithShortcode(tx, "location", {
        name: data.name,
        aliases: data.aliases,
        tags: data.tags ?? [],
        // `type` is the physical form factor; `productId` is identity. A
        // product-linked location can still carry a type (e.g. a raised bed
        // that is also a specific product); without one it is `furniture`.
        type,
        notes: data.notes ?? null,
        productId,
        parentId,
      });

      if (data.pendingImageIds && data.pendingImageIds.length > 0) {
        const resolvedImageIds = await resolveAllPresent(
          tx,
          "image",
          data.pendingImageIds,
        );
        await associatePendingImages(
          tx,
          galleryBinding("location"),
          newLocation.id,
          resolvedImageIds,
        );
      }

      await logAuditEntry(tx, actor, {
        entityKind: "location",
        entityId: newLocation.id,
        action: "create",
      });

      return readOutput(
        { entityId: newLocation.id, shortcode: newLocation.shortcode },
        async () => ({
          output: await readLocationById(tx, newLocation.id),
          entityId: newLocation.id,
        }),
      );
    });
  },
});

/**
 * Identifying predicate for the single global "Unknown" parking location — the
 * uniquely named location a scan/import drops an item into when it has no home
 * yet. Unknown lives directly beneath Home, but name uniqueness means callers
 * do not need to know its current parent to find it.
 */
const isGlobalUnknownLocation = () =>
  and(eq(location.name, "Unknown"), notDeleted(location));

export const ensureGlobalUnknownLocation = async (
  db: Database,
  actor: ActorContext,
) => {
  const findUnknown = () =>
    getDb(db).query.location.findFirst({
      where: isGlobalUnknownLocation(),
      columns: { id: true },
    });

  const existing = await findUnknown();

  if (existing) {
    return readLocationById(db, existing.id);
  }

  try {
    const home = await getHomeLocation(db);
    return await createLocation(
      db,
      {
        name: "Unknown",
        aliases: [],
        type: "area",
        parentId: parseShortcodeFor("location", home.shortcode),
      },
      actor,
    );
  } catch (error) {
    // Location_name_key prevents duplicate active names; if another request won
    // the create race, reuse that row instead of surfacing a transient conflict.
    const raced = await findUnknown();
    if (raced) return readLocationById(db, raced.id);
    throw error;
  }
};

/**
 * `detachedImageKeys` are R2 objects that `removeImageIds` reaped; the caller
 * drops them once its transaction has committed.
 *
 * Careful on the joined branch: `db` may be a caller-owned `DrizzleTransaction`,
 * so "the await resolved" does NOT mean "committed" there. Only the standalone
 * (`Database`) path — the router's — may drain the keys directly. Today the
 * router is the only caller that passes a `Database`.
 */
export const updateLocation = defineMutationWriter({
  entity: "location",
  read: async (
    receipt: MutationReceipt<"location">,
    db: Database | DrizzleTransaction,
    _id: LocationId,
    _data: LocationUpdateInput["data"],
    _actor: ActorContext,
    _options?: { resolvedParentId?: LocationId | null },
  ) => ({
    location: await readLocationById(db, receipt.entityId),
    detachedImageKeys: receipt.detachedImageKeys ?? [],
  }),
  write: async (
    readOutput,
    db: Database | DrizzleTransaction,
    id: LocationId,
    data: LocationUpdateInput["data"],
    actor: ActorContext,
    options?: { resolvedParentId?: LocationId | null },
  ) => {
    let detachedImageKeys: string[] = [];
    const resolveUpdatedParentId = async (tx: DrizzleTransaction) => {
      if (data.parentId === undefined) return undefined;
      const home = await getHomeLocation(tx);
      if (id === home.id) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Home cannot be reparented",
        );
      }
      let parentId: LocationId | null;
      if (options && "resolvedParentId" in options) {
        parentId = options.resolvedParentId ?? home.id;
      } else if (data.parentId === null) {
        parentId = home.id;
      } else {
        const resolved = await resolveLiveShortcode(
          tx,
          data.parentId,
          "location",
        );
        if (!resolved) {
          throw createAppError(
            "REFERENCED_RECORD_MISSING",
            "Cannot set parent: the specified parent location does not exist",
          );
        }
        parentId = parseEntityId("location", resolved);
      }
      if (parentId && (await wouldCreateParentCycle(tx, id, parentId))) {
        throw createAppError(
          "LOCATION_CYCLE_DETECTED",
          "Cannot set parent: would create a circular reference",
        );
      }
      return parentId;
    };

    const resolveUpdatedProductId = async (tx: DrizzleTransaction) => {
      if (data.productId === undefined) return undefined;
      if (data.productId === null) return null;
      const resolved =
        (await resolveLiveShortcode(tx, data.productId, "product")) ??
        raiseMissingProduct();
      return parseEntityId("product", resolved);
    };

    const syncLocationImages = async (
      tx: DrizzleTransaction,
      locationId: LocationId,
    ) => {
      ({ detachedImageKeys } = await syncEntityImages(
        tx,
        "location",
        galleryBinding("location"),
        locationId,
        data,
      ));
    };

    const runUpdate = async (tx: DrizzleTransaction) => {
      const before = await tx.query.location.findFirst({
        where: and(eq(location.id, id), notDeleted(location)),
      });
      const parentId = await resolveUpdatedParentId(tx);
      // `type` (form factor) and `productId` (identity) are independent facts
      // now — neither write clears the other.
      const productId = await resolveUpdatedProductId(tx);
      // `furniture` IS "an instance of a Product": unlinking the Product (or
      // retyping to furniture with none) must say which form factor is left.
      const nextType = data.type ?? before?.type;
      const nextProductId =
        productId === undefined ? before?.productId : productId;
      assertClassificationPolicies("location", {
        type: nextType,
        productId: nextProductId,
      });

      const updateValues = buildPartialUpdateValues({
        name: data.name,
        aliases: data.aliases,
        tags: data.tags,
        type: data.type,
        notes: data.notes,
        productId,
        parentId,
      });

      const updated = await updateLiveAndReturn(tx, location, updateValues, id);

      // Reorder existing images (first = cover) before appending new ones so
      // additions always land after the reordered set. `data.imageOrder` /
      // `data.removeImageIds` are public `IMG-` shortcodes (what
      // `RawLocationOutput.images[].id` hands back) — resolved to uuids here, right
      // before the two helpers below that still take uuids. A code that doesn't
      // resolve is dropped rather than thrown on, matching today's silent
      // no-op for a uuid naming no live row.
      await syncLocationImages(tx, updated.id);

      if (before) {
        const changes = computeChanges(before, updated, [
          ...entityFieldModels.location.audit,
        ]);
        if (changes) {
          await logAuditEntry(tx, actor, {
            entityKind: "location",
            entityId: id,
            action: "update",
            changes,
          });
        }
      }

      const imagesChanged =
        (data.pendingImageIds?.length ?? 0) > 0 ||
        (data.removeImageIds?.length ?? 0) > 0;
      if (imagesChanged && !(await hasLocationImages(tx, id)))
        await updateLocationAiDescription(tx, id, null);
      return readOutput(
        { entityId: id, shortcode: updated.shortcode, detachedImageKeys },
        async () => ({
          location: await readLocationById(tx, updated.id),
          detachedImageKeys,
        }),
      );
    };

    // A rename collides on the same `Location_name_key` a create does, so it gets
    // the same blocker-naming treatment. Only on the standalone branch: when the
    // caller passes its OWN open transaction, the violation has poisoned it and
    // the recovery lookup could not run — that caller rethrows as before.
    if ("rollback" in db) {
      return await runUpdate(db);
    }
    try {
      return await withTransaction(db, runUpdate);
    } catch (error) {
      if (data.name !== undefined) {
        await throwIfDuplicateLocation(db, data.name, error);
      }
      throw error;
    }
  },
  item: (full) => full.location,
});

const refuseHomeLocation = async (
  tx: DrizzleTransaction,
  ids: LocationId[],
) => {
  const home = await getHomeLocation(tx);
  // Its own reason rather than the shared CONSTRAINT_VIOLATION: a structural
  // rule about one specific row, not a generic constraint.
  if (ids.includes(home.id))
    throw createAppError("LOCATION_IS_ROOT", "Home cannot be deleted");
};

/**
 * Promote each surviving child to the nearest ancestor that is not also
 * being deleted. Multi-delete makes the direct parent insufficient: when a
 * room and its shelf go together, the shelf's bins belong under Home, not
 * under the soon-to-be-deleted room.
 */
const promoteSurvivingChildren = async (
  tx: DrizzleTransaction,
  ids: LocationId[],
) => {
  const home = await getHomeLocation(tx);
  const liveLocations = await tx
    .select({ id: location.id, parentId: location.parentId })
    .from(location)
    .where(notDeleted(location));
  const parentById = new Map(
    liveLocations.map((row) => [row.id, row.parentId] as const),
  );
  const deleting = new Set(ids);
  const promotions = new Map<LocationId, LocationId[]>();
  for (const child of liveLocations) {
    if (!child.parentId || !deleting.has(child.parentId)) continue;
    if (deleting.has(child.id)) continue;
    let destinationId: LocationId | null = child.parentId;
    while (destinationId && deleting.has(destinationId))
      destinationId = parentById.get(destinationId) ?? null;
    const survivingParentId = destinationId ?? home.id;
    promotions.set(survivingParentId, [
      ...(promotions.get(survivingParentId) ?? []),
      child.id,
    ]);
  }
  for (const [parentId, childIds] of promotions)
    await tx
      .update(location)
      .set({ parentId })
      .where(and(inArray(location.id, childIds), notDeleted(location)));
};

/**
 * Location deletes take uuids. Returns the R2 keys of images the cascade
 * reaped, for the caller to drop after this commit.
 */
export const deleteLocations = (
  db: Database,
  ids: LocationId[],
  actor: ActorContext,
) =>
  deleteByPolicy(db, {
    entity: "location",
    policy: LOCATION_DELETE_EDGE_POLICY,
    ids,
    actor,
    beforeDelete: refuseHomeLocation,
    overrides: { "Location.parentId": promoteSurvivingChildren },
  });

const qbDirect = new QueryBuilder();

/**
 * The direct stock value: live stock entries' positive stored valuations
 * (ADR 0021), one indexed sum per row instead of valuing the household's
 * whole inventory before the query.
 */
const directValuation = sql<number>`COALESCE((${qbDirect
  .select({ total: sql`sum(${derivedValue.sortNumber})` })
  .from(inventoryEntry)
  .innerJoin(
    derivedValue,
    and(
      eq(derivedValue.entityId, inventoryEntry.id),
      eq(derivedValue.key, "valuation"),
    ),
  )
  .where(
    and(
      eq(inventoryEntry.locationId, location.id),
      notDeleted(inventoryEntry),
      stockOnly(),
      gt(derivedValue.sortNumber, 0),
    ),
  )}), 0)`;

const qb = new QueryBuilder();

// Inner-joins Product (notDeleted) because the Location inventory projection drops inventory
// entries whose product is soft-deleted — without that join, a shelf holding
// only deleted products would count as "has inventory" but render empty.
// Installed fixtures aren't browsable stock, so `stockOnly()`.
const locationIdsWithLiveInventory = qb
  .select({ locationId: inventoryEntry.locationId })
  .from(inventoryEntry)
  .innerJoin(
    product,
    and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
  )
  .where(and(notDeleted(inventoryEntry), stockOnly()));

// Joins Image so this matches what the thumbnail cell renders — it drops PDF
// attachments, and Image is separately soft-deletable from the attachment.
const locationIdsWithImages = qb
  .select({ locationId: entityAttachment.entityId })
  .from(entityAttachment)
  .innerJoin(
    image,
    and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
  )
  .where(and(notDeleted(entityAttachment), displayableImageWhere));

// Aliased because this reads the SAME table the outer query selects from.
const childLocation = alias(location, "child_location");
const locationIdsWithChildren = qb
  .select({ parentId: childLocation.parentId })
  .from(childLocation)
  .where(and(notDeleted(childLocation), isNotNull(childLocation.parentId)));

/** Each location row's relation `with` under `key`, by location id. */
const loadLocationRelation = async <
  K extends keyof typeof relations.location.list.with,
>(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
  key: K,
) => {
  const rows = await unwrapDb(db).query.location.findMany({
    where: inArray(
      location.id,
      ids.map((id) => parseEntityId("location", id)),
    ),
    columns: { id: true },
    // SAFETY: the computed key is `key`, so the object is exactly that pick.
    with: { [key]: relations.location.list.with[key] } as Pick<
      typeof relations.location.list.with,
      K
    >,
  });
  return new Map(rows.map((row) => [row.id, row]));
};

/**
 * The record read's tree: the parent chain and children as full nodes, with
 * stock items and item counts. Batched per id; a record read names one.
 */
const loadLocationTrees = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) =>
  new Map(
    await Promise.all(
      ids.map(
        async (id) =>
          [
            id,
            await loadLocationTree(db, parseEntityId("location", id)),
          ] as const,
      ),
    ),
  );

/**
 * The Location read, stated once: list pages, selected projections and the
 * single-record read all select through it. A page reads compact parent and
 * child refs; the record read replaces them with the full tree.
 */
export const locationScaffold = listScaffold("location", location, {
  derived: {
    // Direct value, because that is what the list cell renders in compact
    // mode.
    valuation: directValuation,
    valuationRollup: storedDerivedSql(
      "location",
      "valuationRollup",
      location.id,
    ),
    // Live stock entries on live products — the same population
    // `hasInventory` reads, so the count filter and the presence agree.
    inventoryEntries: sql.raw(
      `(SELECT count(*) FROM "InventoryEntry" ie ` +
        `INNER JOIN "Product" p ON p."id" = ie."productId" AND ${liveAliasSqlText("p")} ` +
        `WHERE ie."locationId" = "Location"."id" AND ${liveAliasSqlText("ie")} ` +
        `AND ie."placement" = 'stock')`,
    ),
    hasInventory: inArray(location.id, locationIdsWithLiveInventory),
    hasImage: inArray(location.id, locationIdsWithImages),
    hasChildren: inArray(location.id, locationIdsWithChildren),
    hasAiDescription: sql`${locationAiDescriptionSql(location.id)} IS NOT NULL`,
  },
  read: {
    search: locationSearchRead,
    columns: {
      // Not a column: the latest live AiAnalysis text. A single-table select
      // renders an interpolated column bare, so the row is qualified by hand.
      aiDescription: locationAiDescriptionSql(outer(location.id)),
      // The rolled-up valuation the list cell and record read show; the
      // derived `valuation` is the direct value filters and sorts read.
      valuationRollup: sql`(SELECT value FROM "DerivedValue" WHERE "entityId" = ${outer(location.id)} AND key = 'valuationRollup')`,
    },
    media: true,
    bindings: (bind) => {
      const identity = bind.ids(({ db, ids }) =>
        loadLocationRelation(db, ids, "product"),
      );
      const parents = bind.ids(({ db, ids }) =>
        loadLocationRelation(db, ids, "parent"),
      );
      const children = bind.ids(({ db, ids }) =>
        loadLocationRelation(db, ids, "children"),
      );
      const images = bind.ids(({ db, ids }) =>
        loadLocationRelation(db, ids, "images"),
      );
      const stock = bind.ids(({ db, ids }) =>
        loadLocationRelation(db, ids, "inventoryEntries"),
      );
      const trees = bind.ids(({ db, ids }) => loadLocationTrees(db, ids));
      const tree = (
        row: { id: string },
        loaded: Awaited<ReturnType<typeof loadLocationTrees>>,
      ) => {
        const value = loaded.get(row.id);
        if (!value) throw new Error(`Location tree was not loaded: ${row.id}`);
        return value;
      };
      return [
        bind(rawLocationList.pick({ type: true }), (row) => ({
          type: parseLocationType(row.type),
        })),
        identity.fields(
          rawLocationList.pick({ product: true }),
          (row, loaded) => ({
            product: mapLocationIdentityProduct(loaded.get(row.id)),
          }),
        ),
        parents.fields(
          rawLocationList.pick({ parent: true }),
          (row, loaded) => ({
            parent: locationReferenceFields({
              parent: loaded.get(row.id)?.parent ?? null,
              children: [],
            }).parent,
          }),
        ),
        children.fields(
          rawLocationList.pick({ children: true }),
          (row, loaded) => ({
            children: locationReferenceFields({
              parent: null,
              children: loaded.get(row.id)?.children ?? [],
            }).children,
          }),
        ),
        images.fields(
          rawLocationList.pick({ images: true }),
          (row, loaded) => ({
            images: mapImages(loaded.get(row.id)?.images ?? []),
          }),
        ),
        stock.fields(
          rawLocationList.pick({ inventoryEntries: true }),
          (row, loaded) =>
            locationInventoryFields({
              inventoryEntries: (
                loaded.get(row.id)?.inventoryEntries ?? []
              ).map((entry) => ({
                ...entry,
                valuation: entry.storedValuation,
              })),
            }),
        ),
        bind(
          rawLocationList.pick({ valuation: true, valuationLabel: true }),
          (row) => {
            const valuation = locationValuation
              .nullable()
              .parse(row.valuationRollup ?? null);
            return { valuation, valuationLabel: valuationLabel(valuation) };
          },
        ),
        // A root omits `parent` on its record read.
        trees.fields(
          rawLocationDetail.pick({ parent: true, children: true }),
          (row, loaded) => {
            const { parent, children } = tree(row, loaded);
            return { parent: parent ?? undefined, children };
          },
          { scope: "detail" },
        ),
        trees.fields(
          rawLocationDetail.pick({
            childCount: true,
            directItemCount: true,
            totalItemCount: true,
            inventoryItems: true,
          }),
          (row, loaded) => {
            const value = tree(row, loaded);
            return {
              childCount: value.childCount,
              directItemCount: value.directItemCount,
              totalItemCount: value.totalItemCount,
              inventoryItems: value.inventoryItems,
            };
          },
          { scope: "detail" },
        ),
      ];
    },
  },
});

const locationReader = createEntityReader<
  never,
  RawLocationDetail,
  "location",
  Database | DrizzleTransaction
>({
  entity: "location",
  scaffold: locationScaffold,
  output: rawLocationDetail,
});
/** One live Location's record read by internal id; throws `LOCATION_NOT_FOUND`. */
export const readLocationById = locationReader.getByID;

/** Full image metadata for picker DTOs; selection belongs to the canonical resolver. */
const loadLocationCoverImages = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, RawImageOutput>> => {
  const covers = await resolveEntityDisplayImageLists(
    db,
    ids.map((entityId) => ({ entityKind: "location", entityId })),
  );
  const codes = [
    ...new Set(
      [...covers.values()].flatMap((images) =>
        images[0] ? [images[0].id] : [],
      ),
    ),
  ];
  if (!codes.length) return new Map();
  const rows = await getDb(db).query.image.findMany({
    where: inArray(image.shortcode, codes),
  });
  const records = await hydrateImageReadProjection(
    db,
    mapImages(rows.map((image) => ({ image }))),
  );
  const byCode = new Map(records.map((image) => [image.id, image]));
  return new Map(
    ids.flatMap((id) => {
      const cover = covers.get(entityRefKey("location", id))?.[0];
      const record = cover ? byCode.get(cover.id) : undefined;
      return record && cover ? [[id, record]] : [];
    }),
  );
};

/** URL projection of the canonical Location cover, including transitive fallback. */
export const getLocationCoverImageUrlsByLocationIds = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, string>> => {
  const covers = await resolveEntityDisplayImages(
    db,
    ids.map((entityId) => ({ entityKind: "location", entityId })),
  );
  return new Map(
    ids.flatMap((id) => {
      const cover = covers.get(entityRefKey("location", id));
      return cover ? [[id, preferredImageUrl(cover)]] : [];
    }),
  );
};

/**
 * Filters the roster reads accept. Narrowed on purpose: these paths ignore the
 * date/valuation/count filters, and the type should say so rather than accept
 * the full LocationFilters and silently drop them.
 */
type LocationRosterFilters = Pick<
  LocationFilters,
  | "nameFilter"
  | "itemTypeFilter"
  | "parentId"
  | "parentPresenceFilter"
  | "includeSubLocations"
  | "inventoryPresenceFilter"
  | "productId"
  | "productPresenceFilter"
>;

/**
 * Location typeahead for picker comboboxes: one scalar page, its breadcrumbs,
 * and each row's cover photo, which is the other half of telling two
 * same-named shelves apart.
 *
 * Skips the inventory-entry / product / valuation relation load AND the
 * batched product-pricing pass that the Location list read pays for, none of which a
 * dropdown renders. Same split as `productSearch`.
 */
export const locationSearch = async (
  db: Database,
  filters: LocationRosterFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: LocationPickerItemOut[]; count: number }> => {
  // The same declared predicates the list applies, so the two
  // surfaces cannot drift.
  const whereClause = locationScaffold.where(filters);

  const page = await locationScaffold.raw(
    db,
    { filters, sorts, pagination },
    {
      where: whereClause,
      // The picker's own sort roster, not the list's declared one.
      orderBy: buildOrderBy(location, sorts, [...locationPickerSortableFields]),
    },
  );
  const count = z.number().parse(page.count);
  if (!page.data.length) return { ...page, count, data: [] };
  const rows = page.data;

  const ids = rows.map((row) => row.id);
  const [ancestorsById, coverById] = await Promise.all([
    loadLocationAncestors(db, ids),
    loadLocationCoverImages(db, ids),
  ]);
  const referenceRows = [
    ...rows.map((row) => ({
      id: parseShortcodeFor("location", row.shortcode),
      name: row.name,
      type: parseLocationType(row.type),
    })),
    ...rows.flatMap((row) => ancestorsById.get(row.id) ?? []),
  ];
  const coverEntries = [...coverById];
  const coverSchema = locationPickerItemOut.shape.coverImage.unwrap();
  type PublicRead = Parameters<
    typeof publicFieldEnvelopeBatch
  >[0]["reads"][number];
  const serialized = await publicFieldEnvelopeBatch({
    db,
    reads: [
      ...referenceRows.map((row): PublicRead => ({
        entity: "location",
        schema: locationPickerAncestorOut,
        row,
      })),
      ...coverEntries.map(([, row]): PublicRead => ({
        entity: "image",
        schema: coverSchema,
        row,
      })),
    ],
  });
  const references = serialized
    .slice(0, referenceRows.length)
    .map((row) => locationPickerAncestorOut.parse(row));
  const covers = serialized
    .slice(referenceRows.length)
    .map((row) => coverSchema.parse(row));
  const publicCoverById = new Map(
    coverEntries.map(([id], index) => [id, covers[index]]),
  );
  let offset = rows.length;
  return {
    ...page,
    count,
    data: rows.map((row, index) => {
      const count = ancestorsById.get(row.id)?.length ?? 0;
      const ancestors = references.slice(offset, offset + count);
      offset += count;
      return locationPickerItemOut.parse({
        ...references[index],
        aliases: row.aliases ?? [],
        ancestors,
        coverImage: publicCoverById.get(row.id) ?? null,
      });
    }),
  };
};

/**
 * Set or clear a location's AI description outside the model run. The
 * description is the latest live `location-description` AiAnalysis, so
 * "clear" retires those analyses (a location whose last photo was removed has
 * nothing left to describe) and "set" records a manual one that outranks the
 * older analyses without disturbing their cache. `describeLocation` writes
 * its own analysis through `upsertAiAnalysis` and never needs this.
 */
export const updateLocationAiDescription = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
  aiDescription: string | null,
) => {
  await withTransactionOn(db, async (tx) => {
    const client = unwrapDb(tx);
    await client
      .update(aiAnalysis)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(aiAnalysis.entityKind, "location"),
          eq(aiAnalysis.entityId, id),
          eq(aiAnalysis.feature, LOCATION_DESCRIPTION_FEATURE_ID),
          aiDescription === null ? undefined : eq(aiAnalysis.model, "manual"),
          notDeleted(aiAnalysis),
        ),
      );
    if (aiDescription !== null)
      await client.insert(aiAnalysis).values({
        entityKind: "location",
        entityId: id,
        feature: LOCATION_DESCRIPTION_FEATURE_ID,
        model: "manual",
        promptVersion: "manual",
        inputFingerprint: `manual:${id}`,
        result: { description: aiDescription, confidence: "low" },
      });
    await recordChange(tx, {
      kind: "source",
      categories: ["location"],
    });
  });
};

/**
 * Find locations that have images but no AI description.
 * Returns minimal data needed for backfill: id, name, and image URLs.
 */
export const findLocationsNeedingAiDescription = async (
  db: Database,
): Promise<Array<{ id: LocationId; name: string; imageUrls: string[] }>> => {
  const dbClient = getDb(db);

  const locations = await dbClient.query.location.findMany({
    where: and(
      notDeleted(location),
      sql`${locationAiDescriptionSql(location.id)} IS NULL`,
    ),
    columns: { id: true, name: true },
    with: {
      images: {
        columns: {},
        with: {
          image: {
            columns: { key: true },
          },
        },
      },
    },
  });

  return locations
    .filter((loc) => loc.images.length > 0)
    .map((loc) => ({
      id: loc.id,
      name: loc.name,
      imageUrls: loc.images.map((li) => getR2PublicUrl(li.image.key)),
    }));
};

/** One location's record tree: parent chain, children, stock items, counts. */
const loadLocationTree = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
): Promise<RawLocationDetail> => {
  const res = await unwrapDb(db).query.location.findFirst({
    where: and(eq(location.id, id), notDeleted(location)),
    ...relations.location.full,
  });

  if (!res) {
    throw createAppError("LOCATION_NOT_FOUND", `Location ${id} not found`);
  }

  // The parent chain (up to 10 levels) in two round trips at any depth: one
  // recursive walk for the ids, then one read with images. Like the walk it
  // replaced, it does not filter deleted ancestors.
  let parentChain: LocationWithParentChild | null = null;
  const chainRows = res.parentId
    ? (
        await unwrapDb(db).execute<{ id: LocationId }>(sql`
          WITH RECURSIVE chain AS (
            SELECT ${location.id} AS id, ${location.parentId} AS "parentId", 1 AS depth
            FROM ${location} WHERE ${location.id} = ${res.parentId}
            UNION ALL
            SELECT l."id", l."parentId", c.depth + 1
            FROM ${location} l JOIN chain c ON l."id" = c."parentId"
            WHERE c.depth < 10
          )
          SELECT id FROM chain ORDER BY depth
        `)
      ).rows
    : [];
  // Immediate parent first, matching the order data qualities are loaded in.
  const parentChainIds = chainRows.map((row) => row.id);
  if (parentChainIds.length > 0) {
    const parentsById = new Map(
      (
        await unwrapDb(db).query.location.findMany({
          where: inArray(location.id, parentChainIds),
          ...relations.location.withImages,
        })
      ).map((parent) => [parent.id, parent]),
    );
    // Build root-first so the result is the immediate parent, linked upward.
    for (const parentId of [...parentChainIds].reverse()) {
      const parentData = parentsById.get(parentId);
      if (!parentData) continue;
      parentChain = {
        ...parentData,
        children: [],
        parent: parentChain,
        images: parentData.images,
      };
    }
  }

  // Enrich children with counts so the frontend doesn't need extra queries
  const activeChildren = (res.children ?? []).filter(
    (c) => c.id !== id && c.deletedAt === null,
  );
  const childIds = activeChildren.map((c) => c.id);

  const childCountMap: Record<string, number> = {};

  const dbClient = unwrapDb(db);

  // The fetched location is loaded alongside its children, not just the
  // children: `buildLocationWithChildren` derives totalItemCount from the
  // root's own directItemCount, so leaving the root out made every count
  // surface reading this payload (the location hovercard, the Contents
  // header's fallback) report 0 for a location that holds stock directly and
  // has no children to roll up.
  const [
    childCountResults,
    stockItemsByLocationId,
    valuations,
    dataQualities,
    displayImages,
  ] = await Promise.all([
    childIds.length > 0
      ? dbClient
          .select({
            parentId: location.parentId,
            count: sql<number>`count(*)::int`,
          })
          .from(location)
          .where(
            and(notDeleted(location), inArray(location.parentId, childIds)),
          )
          .groupBy(location.parentId)
      : [],
    // Items and count come from the same rows so the resource detail cannot
    // report `directItemCount: 12` next to `inventoryItems: []` again.
    loadStockItemsByLocation(db, [id, ...childIds]),
    loadStoredLocationValuations(db, [id, ...childIds, ...parentChainIds]),
    // Root, every direct child and the whole ancestor chain — everywhere
    // `buildLocationWithChildren` recurses into below.
    loadDataQualities(db, "location", [id, ...childIds, ...parentChainIds]),
    resolveEntityDisplayImageLists(
      db,
      [id, ...childIds, ...parentChainIds].map((entityId) => ({
        entityKind: "location",
        entityId,
      })),
    ),
  ]);

  for (const row of childCountResults) {
    if (row.parentId) childCountMap[row.parentId] = row.count;
  }

  // Attach counts to children
  const enrichedChildren: LocationWithParentChild[] = (res.children ?? []).map(
    (child) => ({
      ...child,
      childCount: childCountMap[child.id] ?? 0,
      inventoryItems: stockItemsByLocationId.get(child.id) ?? [],
    }),
  );

  const locationWithParent: LocationWithParentChild = {
    ...res,
    parent: parentChain,
    children: enrichedChildren,
    inventoryItems: stockItemsByLocationId.get(id) ?? [],
    images: res.images,
  };

  return buildLocationWithChildren(
    locationWithParent,
    id,
    true,
    valuations,
    dataQualities,
    displayImages,
  );
};

/** Only image presence is required when clearing a description after the last attachment is removed. */
const hasLocationImages = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
): Promise<boolean> => {
  const [row] = await unwrapDb(db)
    .select({ id: entityAttachment.id })
    .from(entityAttachment)
    .innerJoin(
      image,
      and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
    )
    .where(and(eq(entityAttachment.entityId, id), notDeleted(entityAttachment)))
    .limit(1);
  return row !== undefined;
};

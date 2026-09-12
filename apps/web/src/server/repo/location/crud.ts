import type { ActorContext } from "@cubby/schemas/context";
/**
 * Location CRUD operations.
 * Core create, read, update, delete, list operations for locations.
 */
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { generatedEntitySort } from "@cubby/schemas/entity-sort";
import {
  type ImageShortcode,
  type LocationId,
  type ProductId,
  parseEntityId,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import { isDisplayableImageFile } from "@cubby/schemas/image";
import type {
  InfLocation,
  LocationCreateInput,
  LocationOptionItemOut,
  LocationPickerItemOut,
  LocationUpdateInput,
} from "@cubby/schemas/location";
import { locationPickerSortableFields } from "@cubby/schemas/location";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  image,
  inventoryEntry,
  location,
  locationImage,
  product,
  productImage,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  isUniqueViolation,
  type UnparsedDatabaseError,
} from "~/server/errors/db-errors";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  applyImageOrder,
  assertNoDependents,
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  buildPartialUpdateValues,
  buildSearchConditions,
  countWhere,
  eqAny,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  idSetPresence,
  imageJoinBindings,
  imageOrder,
  type ListReadIntent,
  lockAndValidateForDelete,
  mapImages,
  nextImageSortOrder,
  notDeleted,
  presenceCondition,
  rangeConditions,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { declaredFilterPredicates } from "~/server/repo/declared-filter-predicates";
import { detachImagesFromEntity } from "~/server/repo/image";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { stockOnly } from "~/server/repo/inventory/placement";
import { parseLocationType } from "~/server/repo/location/parse-type";
import { loadProductPricing } from "~/server/repo/product/pricing";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllPresent,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

import { buildLocationWithChildren, dbLocationToListAPI } from "./helpers";
import { getHomeLocation } from "./home";
import type {
  LocationFilters,
  LocationWithParentChild,
} from "./internal-types";
import { loadStockItemsByLocation } from "./stock-items";
import { loadLocationAncestors, wouldCreateParentCycle } from "./tree";

export const LOCATION_DELETE_EDGE_POLICY = {
  "InventoryEntry.locationId": {
    code: "block-live-inventory",
    effect: "block",
    description:
      "A location still holding inventory can't be deleted — move or remove the inventory first.",
  },
  "LocationImage.locationId": {
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
} as const satisfies IncomingEdgePolicy<"location", OperationDisposition>;

/**
 * Live inventory sitting in the given locations. Used by `deleteLocations`,
 * which refuses when any exist.
 */
const findLocationsWithLiveInventory = (
  db: Database | DrizzleTransaction,
  ids: LocationId[],
) =>
  unwrapDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.locationId, ids),
      notDeleted(inventoryEntry),
    ),
    columns: { locationId: true },
  });

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
) => {
  try {
    return await createLocationTx(db, data, actor);
  } catch (error) {
    // Safe on a clean connection: withTransaction has already rolled back.
    await throwIfDuplicateLocation(db, data.name, error);
    throw error;
  }
};

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

const createLocationTx = async (
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
    const newLocation = await insertWithShortcode(tx, "location", {
      name: data.name,
      aliases: data.aliases,
      tags: data.tags ?? [],
      // Form factor is a fact about the SKU, so a linked location stores no
      // type of its own.
      type: productId ? null : (data.type ?? null),
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
        imageJoinBindings.location,
        newLocation.id,
        resolvedImageIds,
      );
    }

    await logAuditEntry(tx, actor, {
      entityType: "location",
      entityId: newLocation.id,
      action: "create",
    });

    return getLocationById(tx, newLocation.id);
  });
};

/**
 * Identifying predicate for the single global "Unknown" parking location — the
 * uniquely named location a scan/import drops an item into when it has no home
 * yet. Unknown lives directly beneath Home, but name uniqueness means callers
 * do not need to know its current parent to find it.
 * Exported so every consumer (ensure-or-create below, the Problems
 * "parked in Unknown" detector) agrees on what "Unknown" means.
 */
export const isGlobalUnknownLocation = () =>
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
    return getLocationById(db, existing.id);
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
    if (raced) return getLocationById(db, raced.id);
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
export const updateLocation = async (
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
      throw createAppError("CONSTRAINT_VIOLATION", "Home cannot be reparented");
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
    if (data.imageOrder?.length) {
      const orderedIds = await resolveAllPresent(tx, "image", data.imageOrder);
      await applyImageOrder(
        tx,
        imageJoinBindings.location,
        locationId,
        orderedIds,
      );
    }
    if (data.removeImageIds?.length) {
      const idsToRemove = await resolveAllPresent(
        tx,
        "image",
        data.removeImageIds,
      );
      ({ deletedKeys: detachedImageKeys } = await detachImagesFromEntity(
        tx,
        { entity: "location", id: locationId },
        idsToRemove,
      ));
    }
    if (data.pendingImageIds?.length) {
      const pendingIds = await resolveAllPresent(
        tx,
        "image",
        data.pendingImageIds,
      );
      const startSortOrder = await nextImageSortOrder(
        tx,
        imageJoinBindings.location,
        locationId,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.location,
        locationId,
        pendingIds,
        startSortOrder,
      );
    }
  };

  const runUpdate = async (tx: DrizzleTransaction) => {
    const before = await tx.query.location.findFirst({
      where: and(eq(location.id, id), notDeleted(location)),
    });
    const parentId = await resolveUpdatedParentId(tx);
    const requestedProductId = await resolveUpdatedProductId(tx);
    // The fields are alternatives. Linking a product clears type; explicitly
    // choosing a type on an existing product-backed Location switches it back
    // to a productless typed Location. Null remains meaningful on either side,
    // so callers can deliberately store the valid both-null state.
    const productId =
      requestedProductId === undefined && data.type != null
        ? null
        : requestedProductId;

    const updateValues = buildPartialUpdateValues({
      name: data.name,
      aliases: data.aliases,
      tags: data.tags,
      // Linking a product clears the now-redundant type; the two are
      // alternatives, never companions.
      type: productId ? null : data.type,
      productId,
      parentId,
    });

    const updated = await updateLiveAndReturn(tx, location, updateValues, id);

    // Reorder existing images (first = cover) before appending new ones so
    // additions always land after the reordered set. `data.imageOrder` /
    // `data.removeImageIds` are public `IMG-` shortcodes (what
    // `LocationOut.images[].id` hands back) — resolved to uuids here, right
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
          entityType: "location",
          entityId: id,
          action: "update",
          changes,
        });
      }
    }

    return getLocationById(tx, updated.id);
  };

  // A rename collides on the same `Location_name_key` a create does, so it gets
  // the same blocker-naming treatment. Only on the standalone branch: when the
  // caller passes its OWN open transaction, the violation has poisoned it and
  // the recovery lookup could not run — that caller rethrows as before.
  if ("rollback" in db) {
    return { location: await runUpdate(db), detachedImageKeys };
  }
  try {
    const location = await withTransaction(db, runUpdate);
    return { location, detachedImageKeys };
  } catch (error) {
    if (data.name !== undefined) {
      await throwIfDuplicateLocation(db, data.name, error);
    }
    throw error;
  }
};

/**
 * Move a set of locations below one parent without replaying the full
 * single-location update pipeline for every row. Bulk reparenting has no image
 * work and does not return hydrated locations, so the per-row re-fetches are
 * pure overhead; it still keeps the cycle check and one audit entry per changed
 * location.
 */
export const bulkReparentLocations = async (
  db: Database,
  rawIds: LocationId[],
  requestedParentId: LocationId | null,
  actor: ActorContext,
): Promise<void> => {
  // Dedupe so the `updated.length !== ids.length` guard below holds even for
  // callers that don't pre-dedupe: `inArray` collapses duplicate ids in the
  // UPDATE, so a duplicate in `ids` would otherwise trip a spurious
  // LOCATION_NOT_FOUND.
  const ids = uniq(rawIds);
  await withTransaction(db, async (tx) => {
    const home = await getHomeLocation(tx);
    const parentId = requestedParentId ?? home.id;
    if (ids.includes(home.id)) {
      throw createAppError("CONSTRAINT_VIOLATION", "Home cannot be reparented");
    }
    // One snapshot serves both live-row validation and the parent-chain walk.
    // Walking parent pointers in memory avoids one database round-trip per
    // selected location while preserving the same "parent cannot be a
    // descendant" invariant as updateLocation.
    const liveLocations = await tx
      .select({ id: location.id, parentId: location.parentId })
      .from(location)
      .where(notDeleted(location));
    const parents = new Map(
      liveLocations.map((row) => [row.id, row.parentId] as const),
    );
    const selected = new Set(ids);

    for (const id of ids) {
      if (!parents.has(id)) {
        throw createAppError("LOCATION_NOT_FOUND", `Location ${id} not found`);
      }
    }

    if (parentId) {
      let currentId: LocationId | null = parentId;
      while (currentId) {
        if (selected.has(currentId)) {
          throw createAppError(
            "LOCATION_CYCLE_DETECTED",
            "Cannot set parent: would create a circular reference",
          );
        }
        currentId = parents.get(currentId) ?? null;
      }
    }

    const changed = liveLocations.filter(
      (row) => selected.has(row.id) && row.parentId !== parentId,
    );
    const updated = await tx
      .update(location)
      .set({ parentId })
      .where(and(inArray(location.id, ids), notDeleted(location)))
      .returning({ id: location.id });

    // A row deleted between the snapshot and update must roll back rather than
    // reporting a successful move/audit for a row it did not update.
    if (updated.length !== ids.length) {
      throw createAppError("LOCATION_NOT_FOUND", "A location was not found");
    }

    await logAuditEntries(
      tx,
      actor,
      changed.map((row) => ({
        entityType: "location" as const,
        entityId: row.id,
        action: "update" as const,
        changes: { parentId: { from: row.parentId, to: parentId } },
      })),
    );
  });
};

/**
 * Soft delete locations by setting deletedAt timestamp.
 * Also soft deletes related images.
 * Child locations are promoted to the nearest surviving ancestor.
 * Throws if any location has inventory.
 */
/**
 * Returns the R2 keys of images the cascade reaped, for the caller to drop
 * after this commit — an object delete has no rollback.
 */
export const deleteLocations = async (
  db: Database,
  ids: LocationId[],
  actor: ActorContext,
): Promise<{
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
  deleted: number;
}> => {
  if (ids.length === 0)
    return { detachedImageKeys: [], deletedImageShortcodes: [], deleted: 0 };

  return await withTransaction(db, async (tx) => {
    // Lock locations and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, location, ids, "Location");
    const home = await getHomeLocation(tx);
    if (ids.includes(home.id)) {
      // Its own reason rather than the shared CONSTRAINT_VIOLATION: this is a
      // structural rule about one specific row, not a generic constraint, and
      // a caller could not previously tell it apart from any other refusal.
      throw createAppError("LOCATION_IS_ROOT", "Home cannot be deleted");
    }

    // Safety check: don't delete if any location has inventory
    const withInventory = await findLocationsWithLiveInventory(tx, ids);
    await assertNoDependents({
      offendingParentIds: withInventory.map((e) => e.locationId),
      fetchNames: (failedIds) =>
        tx.query.location.findMany({
          where: inArray(location.id, failedIds),
          columns: { name: true },
        }),
      reason: "LOCATION_HAS_INVENTORY",
      message: (count, names) =>
        `Cannot delete ${count} location(s): ${names} have inventory entries. Move or remove them first.`,
    });

    // Promote each surviving child to the nearest ancestor that is not also
    // being deleted. Multi-delete makes the direct parent insufficient: when a
    // room and its shelf go together, the shelf's bins belong under Home, not
    // under the soon-to-be-deleted room.
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
      while (destinationId && deleting.has(destinationId)) {
        destinationId = parentById.get(destinationId) ?? null;
      }
      const survivingParentId = destinationId ?? home.id;
      const childIds = promotions.get(survivingParentId) ?? [];
      childIds.push(child.id);
      promotions.set(survivingParentId, childIds);
    }
    for (const [parentId, childIds] of promotions) {
      await tx
        .update(location)
        .set({ parentId })
        .where(and(inArray(location.id, childIds), notDeleted(location)));
    }

    return await removeEntity(tx, {
      entity: "location",
      ids,
      removal: "soft",
      actor,
      children: [
        {
          table: locationImage,
          parentColumns: [locationImage.locationId],
          auditKey: "cascadedImages",
        },
      ],
    });
  });
};

/**
 * The free-text match behind both the location table's name filter and the
 * picker typeahead: name ∪ AI description ∪ aliases. Shared so the two surfaces
 * can't drift into disagreeing about what "matches" means.
 */
const locationNameSearchCondition = (nameFilter: string | undefined) =>
  nameFilter
    ? or(
        formatSearchTerm(location.name, nameFilter),
        formatSearchTerm(location.aiDescription, nameFilter),
        sql`EXISTS (SELECT 1 FROM unnest(${location.aliases}) AS alias WHERE alias ILIKE ${`%${nameFilter}%`})`,
      )
    : undefined;

/**
 * "Which SKU is this location an instance of", plus the has/none presence
 * split. A requested-but-unresolvable product code must match nothing rather
 * than widening to an unfiltered query — the same rule the parent filter
 * follows directly above.
 */
const locationProductCondition = async (
  db: Database,
  filters: Pick<LocationFilters, "productId" | "productPresenceFilter">,
) => {
  const codes = filters.productId ? [filters.productId].flat() : [];
  const ids = await resolveAllPresent(db, "product", codes);
  if (codes.length > 0 && ids.length === 0) {
    return filters.productPresenceFilter
      ? eqAnyOrPresence(location.productId, [], filters.productPresenceFilter)
      : sql`false`;
  }
  return eqAnyOrPresence(
    location.productId,
    ids,
    filters.productPresenceFilter,
  );
};

/**
 * The full `locationList` predicate: parent/product resolution plus the
 * uncorrelated live-inventory/children/image/valuation subqueries. Exported so
 * `getEntityCounts` can call `buildLocationWhere(db, {})` and get the list's
 * REAL population rather than a hand-restated copy that can drift from it.
 */
export const buildLocationWhere = async (
  db: Database,
  filters: LocationFilters,
): Promise<SQL | undefined> => {
  const parentCodes = filters.parentId ? [filters.parentId].flat() : [];
  const parentIds = await resolveAllPresent(db, "location", parentCodes);
  const parentCondition =
    parentCodes.length > 0 && parentIds.length === 0
      ? filters.parentPresenceFilter
        ? eqAnyOrPresence(location.parentId, [], filters.parentPresenceFilter)
        : sql`false`
      : eqAnyOrPresence(
          location.parentId,
          parentIds,
          filters.parentPresenceFilter,
        );
  const productCondition = await locationProductCondition(db, filters);
  // Uncorrelated subquery of location ids holding live inventory. Inner-joins
  // Product (notDeleted) because dbLocationToListAPI drops inventory entries
  // whose product is soft-deleted — without that join, a shelf holding only
  // deleted products would count as "has inventory" here but render empty on
  // the list, so an empty-shelf search would miss it.
  const locationIdsWithLiveInventory = getDb(db)
    .select({ locationId: inventoryEntry.locationId })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    // Installed fixtures aren't browsable stock — an "has inventory" filter
    // must not match a location whose only item is wired into the wall.
    .where(and(notDeleted(inventoryEntry), stockOnly()));
  // Joins Image so this matches what the thumbnail cell actually renders — it
  // drops PDF attachments, and Image is separately soft-deletable from
  // LocationImage.
  // Aliased because this reads the SAME table the outer query selects from.
  // Uncorrelated — it names every location that is somebody's parent — but the
  // alias keeps the inner reference unambiguous rather than relying on Postgres
  // shadowing the outer `Location`.
  const childLocation = alias(location, "child_location");
  const locationIdsWithChildren = getDb(db)
    .select({ parentId: childLocation.parentId })
    .from(childLocation)
    .where(and(notDeleted(childLocation), isNotNull(childLocation.parentId)));
  const locationIdsWithImages = getDb(db)
    .select({ locationId: locationImage.locationId })
    .from(locationImage)
    .innerJoin(
      image,
      and(eq(image.id, locationImage.imageId), notDeleted(image)),
    )
    .where(and(notDeleted(locationImage), displayableImageWhere));
  const locationIdsMeetingInventoryMinimum = getDb(db)
    .select({ locationId: inventoryEntry.locationId })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    .where(and(notDeleted(inventoryEntry), stockOnly()))
    .groupBy(inventoryEntry.locationId)
    .having(sql`count(*) >= ${filters.directItemCountMin ?? 0}`);
  const locationIdsExceedingInventoryMaximum = getDb(db)
    .select({ locationId: inventoryEntry.locationId })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    .where(and(notDeleted(inventoryEntry), stockOnly()))
    .groupBy(inventoryEntry.locationId)
    .having(sql`count(*) > ${filters.directItemCountMax ?? 0}`);

  return buildSearchConditions(
    location,
    [],
    [
      ...auditDateWhereConditions(location, filters),
      ...relatedWhereConditions("location", filters, location.id),
      locationNameSearchCondition(filters.nameFilter),
      // `type` is a declared stored filter.
      ...declaredFilterPredicates("location", location, filters),
      parentCondition,
      productCondition,
      idSetPresence(
        location.id,
        filters.inventoryPresenceFilter,
        locationIdsWithLiveInventory,
      ),
      idSetPresence(
        location.id,
        filters.imagePresenceFilter,
        locationIdsWithImages,
      ),
      presenceCondition(
        location.aiDescription,
        filters.aiDescriptionPresenceFilter,
      ),
      idSetPresence(
        location.id,
        filters.childPresenceFilter,
        locationIdsWithChildren,
      ),
      filters.lastBulkInventoryOlderThanDays !== undefined
        ? or(
            isNull(location.lastBulkInventory),
            sql`${location.lastBulkInventory} < now() - make_interval(days => ${filters.lastBulkInventoryOlderThanDays})`,
          )
        : undefined,
      filters.directItemCountMin !== undefined
        ? inArray(location.id, locationIdsMeetingInventoryMinimum)
        : undefined,
      filters.directItemCountMax !== undefined
        ? notInArray(location.id, locationIdsExceedingInventoryMaximum)
        : undefined,
      ...rangeConditions(
        sql`COALESCE((${location.valuation}->>'directValuation')::numeric, 0)`,
        filters,
        "valuation",
      ),
    ],
  );
};

export const locationList = async (
  db: Database,
  filters: LocationFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  groupBy?: string,
  readIntent: ListReadIntent = "page",
) => {
  const whereClause = await buildLocationWhere(db, filters);

  const orderByClause = buildOrderBy(
    location,
    sorts,
    [...generatedEntitySort.location.fields],
    {
      groupBy,
      // `valuation` is a persisted jsonb rollup; sort by direct value because
      // that is what the list cell renders in compact mode.
      resolve: (s) => {
        const dirSql =
          s.direction === "asc" ? "asc nulls last" : "desc nulls last";
        if (s.orderBy === "valuation")
          return [
            s.direction === "asc"
              ? sql`(${location.valuation}->>'directValuation')::numeric asc nulls last`
              : sql`(${location.valuation}->>'directValuation')::numeric desc nulls last`,
          ];
        if (s.orderBy === "inventoryEntries")
          return [
            // Matches locationIdsMeetingInventoryMinimum/ExceedingMaximum's
            // stockOnly() filter — otherwise sort and filter disagree on
            // whether an installed fixture counts.
            sql.raw(
              `(SELECT count(*) FROM "InventoryEntry" ie ` +
                `INNER JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL ` +
                `WHERE ie."locationId" = "location"."id" AND ie."deletedAt" IS NULL ` +
                `AND ie."placement" = 'stock') ${dirSql}`,
            ),
          ];
        // Joined parent name — a correlated subquery keeps this a relational
        // findMany. Soft-delete guarded, like the read path.
        if (s.orderBy === "parent")
          return [
            sql.raw(
              `(SELECT l."name" FROM "Location" l ` +
                `WHERE l."id" = "location"."parentId" AND l."deletedAt" IS NULL) ${dirSql}`,
            ),
          ];
        return null;
      },
    },
  );

  const { take, skip } = buildTakeSkip(pagination);

  const { data: results, count: totalCount } = await executeListQueryWithCount({
    kind: readIntent,
    rows: () =>
      getDb(db).query.location.findMany({
        where: whereClause,
        ...relations.location.list,
        orderBy: orderByClause,
        limit: take,
        offset: skip,
      }),
    count: () => countWhere(db, location, whereClause),
  });
  if (readIntent === "count") {
    return { data: [], count: totalCount };
  }

  // One batched pricing load for the whole page (never per-row): flatten every
  // live inventory entry's product across the page and price them together, then
  // thread the map into dbLocationToListAPI.
  const pageProducts = results.flatMap((row) =>
    row.inventoryEntries.map((entry) => entry.product),
  );
  const pricingByProductId = await loadProductPricing(db, pageProducts);
  const items = results.map((row) =>
    dbLocationToListAPI(row, pricingByProductId),
  );
  return { data: items, count: totalCount };
};

/**
 * Cover photo per location — first displayable image by `imageOrder` — for a
 * page of ids, in one query. Non-displayable rows (PDF attachments, failed
 * renders, missing storage) don't block the location: the next image gets the
 * slot, matching what the thumbnail cells elsewhere actually render.
 */
const loadLocationCoverImages = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, ImageOut>> => {
  const byId = new Map<LocationId, ImageOut>();
  if (ids.length === 0) return byId;

  const rows = await getDb(db).query.locationImage.findMany({
    where: and(
      inArray(locationImage.locationId, ids),
      notDeleted(locationImage),
    ),
    orderBy: imageOrder,
    with: { image: true },
  });

  for (const row of rows) {
    if (byId.has(row.locationId)) continue;
    const [mapped] = mapImages([row]);
    if (mapped && isDisplayableImageFile(mapped)) {
      byId.set(row.locationId, mapped);
    }
  }
  return byId;
};

/**
 * First displayable product cover for each live identity SKU, in one batched
 * relation read. This is deliberately separate from LocationImage: callers
 * may render it as a location cover, but it remains product-owned media.
 */
const loadIdentityProductCoverImages = async (
  db: Database,
  ids: ProductId[],
): Promise<Map<ProductId, ImageOut>> => {
  const byId = new Map<ProductId, ImageOut>();
  if (ids.length === 0) return byId;
  const uniqueIds = [...new Set(ids)];

  const rows = await getDb(db).query.product.findMany({
    where: and(inArray(product.id, uniqueIds), notDeleted(product)),
    columns: { id: true },
    with: {
      images: {
        where: notDeleted(productImage),
        orderBy: imageOrder,
        with: { image: true },
      },
    },
  });

  for (const row of rows) {
    const cover = mapImages(row.images).find(isDisplayableImageFile);
    if (cover) byId.set(row.id, cover);
  }
  return byId;
};

/**
 * One displayable cover URL for each requested Location. An own Location photo
 * wins; a product-backed Location falls back to the cover of the Product it
 * represents. This is the compact-list counterpart to `LocationVisual`'s
 * richer client-side resolver and keeps list callers from duplicating the two
 * batched image reads.
 */
export const getLocationCoverImageUrlsByLocationIds = async (
  db: Database,
  ids: LocationId[],
): Promise<Map<LocationId, string>> => {
  const byId = new Map<LocationId, string>();
  if (ids.length === 0) return byId;

  const rows = await getDb(db)
    .select({ id: location.id, productId: location.productId })
    .from(location)
    .where(and(inArray(location.id, ids), notDeleted(location)));
  const productIds = rows.flatMap((row) =>
    row.productId ? [row.productId] : [],
  );
  const [ownCovers, identityProductCovers] = await Promise.all([
    loadLocationCoverImages(db, ids),
    loadIdentityProductCoverImages(db, productIds),
  ]);

  for (const row of rows) {
    const cover =
      ownCovers.get(row.id) ??
      (row.productId ? identityProductCovers.get(row.productId) : undefined);
    if (cover) byId.set(row.id, cover.url);
  }
  return byId;
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
  | "inventoryPresenceFilter"
  | "productId"
  | "productPresenceFilter"
>;

/**
 * The shared body of both roster reads: one scalar page + its breadcrumbs.
 *
 * Skips the inventory-entry / product / valuation relation load AND the
 * batched product-pricing pass that `locationList` pays for, none of which a
 * dropdown renders. Same split as `productSearch`.
 */
const locationRosterPage = async (
  db: Database,
  filters: LocationRosterFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{
  data: LocationOptionItemOut[];
  ids: LocationId[];
  productIds: Array<ProductId | null>;
  count: number;
}> => {
  const parentCodes = filters.parentId ? [filters.parentId].flat() : [];
  const parentIds = await resolveAllPresent(db, "location", parentCodes);
  // A requested-but-unresolvable parent must match nothing rather than widening
  // to an unfiltered query — same rule as `locationList`.
  const parentCondition =
    parentCodes.length > 0 && parentIds.length === 0
      ? filters.parentPresenceFilter
        ? eqAnyOrPresence(location.parentId, [], filters.parentPresenceFilter)
        : sql`false`
      : eqAnyOrPresence(
          location.parentId,
          parentIds,
          filters.parentPresenceFilter,
        );

  const locationIdsWithLiveInventory = getDb(db)
    .select({ locationId: inventoryEntry.locationId })
    .from(inventoryEntry)
    .innerJoin(
      product,
      and(eq(product.id, inventoryEntry.productId), notDeleted(product)),
    )
    // Installed fixtures aren't browsable stock — a location picker's "has
    // inventory" filter must not match on a wired-in fixture alone.
    .where(and(notDeleted(inventoryEntry), stockOnly()));

  const productCondition = await locationProductCondition(db, filters);

  const whereClause = buildSearchConditions(
    location,
    [],
    [
      locationNameSearchCondition(filters.nameFilter),
      eqAny(location.type, filters.itemTypeFilter),
      parentCondition,
      productCondition,
      idSetPresence(
        location.id,
        filters.inventoryPresenceFilter,
        locationIdsWithLiveInventory,
      ),
    ],
  );

  const orderByClause = buildOrderBy(location, sorts, [
    ...locationPickerSortableFields,
  ]);
  const { take, skip } = buildTakeSkip(pagination);

  const { data: results, count: totalCount } = await executeListQueryWithCount(
    // No `...relations.location.list` — scalar columns only.
    getDb(db).query.location.findMany({
      where: whereClause,
      columns: {
        id: true,
        shortcode: true,
        name: true,
        type: true,
        aliases: true,
        productId: true,
      },
      orderBy: orderByClause,
      limit: take,
      offset: skip,
    }),
    countWhere(db, location, whereClause),
  );

  const ids = results.map((row) => row.id);
  const ancestorsById = await loadLocationAncestors(db, ids);

  const data = results.map((row) => ({
    id: parseShortcodeFor("location", row.shortcode),
    name: row.name,
    type: parseLocationType(row.type, { id: row.id, name: row.name }),
    aliases: row.aliases ?? [],
    ancestors: ancestorsById.get(row.id) ?? [],
  }));

  return {
    data,
    ids,
    productIds: results.map((row) => row.productId),
    count: totalCount,
  };
};

/**
 * Breadcrumb-only roster — for filter picklists, which render a name and its
 * ancestry and nothing else. Skips the cover-image load entirely; the product
 * list pulls 500 of these on every options load and draws no thumbnails.
 */
export const locationOptions = async (
  db: Database,
  filters: LocationRosterFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: LocationOptionItemOut[]; count: number }> => {
  const { data, count } = await locationRosterPage(
    db,
    filters,
    sorts,
    pagination,
  );
  return { data, count };
};

/**
 * Location typeahead for picker comboboxes — the roster plus each row's cover
 * photo, which is the other half of telling two same-named shelves apart.
 */
export const locationSearch = async (
  db: Database,
  filters: LocationRosterFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
): Promise<{ data: LocationPickerItemOut[]; count: number }> => {
  const { data, ids, productIds, count } = await locationRosterPage(
    db,
    filters,
    sorts,
    pagination,
  );
  const [coverById, productCoverById] = await Promise.all([
    loadLocationCoverImages(db, ids),
    loadIdentityProductCoverImages(
      db,
      productIds.filter((id): id is ProductId => id !== null),
    ),
  ]);

  return {
    data: data.map((row, index) => ({
      ...row,
      // `ids` is the same page in the same order — `data` is a 1:1 map of it.
      coverImage:
        coverById.get(ids[index]!) ??
        (productIds[index] ? productCoverById.get(productIds[index]!) : null) ??
        null,
    })),
    count,
  };
};

export const updateLocationAiDescription = async (
  db: Database,
  id: LocationId,
  aiDescription: string | null,
) => {
  await updateLiveAndReturn(db, location, { aiDescription }, id);
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
    where: and(notDeleted(location), isNull(location.aiDescription)),
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

export const getLocationById = async (
  db: Database | DrizzleTransaction,
  id: LocationId,
): Promise<InfLocation> => {
  const res = await unwrapDb(db).query.location.findFirst({
    where: and(eq(location.id, id), notDeleted(location)),
    ...relations.location.full,
  });

  if (!res) {
    throw createAppError("LOCATION_NOT_FOUND", `Location ${id} not found`);
  }

  // Fetch parent chain recursively (up to 10 levels)
  let parentChain: LocationWithParentChild | null = null;
  if (res.parentId) {
    let currentParentId: LocationId | null = res.parentId;
    let depth = 0;
    const parents: Array<
      typeof location.$inferSelect & {
        images: Array<{
          image: typeof image.$inferSelect;
        }>;
      }
    > = [];

    while (currentParentId && depth < 10) {
      const parentData: (typeof parents)[number] | undefined = await unwrapDb(
        db,
      ).query.location.findFirst({
        where: eq(location.id, currentParentId),
        ...relations.location.withImages,
      });

      if (!parentData) break;

      parents.unshift(parentData);
      currentParentId = parentData.parentId;
      depth++;
    }

    for (const parentData of parents) {
      const parentWithRelations: LocationWithParentChild = {
        ...parentData,
        children: [],
        parent: parentChain,
        images: parentData.images,
      };
      parentChain = parentWithRelations;
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
  const [childCountResults, stockItemsByLocationId] = await Promise.all([
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

  return buildLocationWithChildren(locationWithParent, id);
};

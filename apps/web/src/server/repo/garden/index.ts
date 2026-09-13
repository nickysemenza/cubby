import type { ActorContext } from "@cubby/schemas/context";
import {
  type GardenPlantingOut,
  gardenCreatePlantingInput,
  gardenEntryKind,
  gardenLocationKind,
  gardenRecordEntryInput,
  gardenEntryOut,
  gardenOverviewOut,
  gardenOptionsOut,
  plantingOut,
} from "@cubby/schemas/garden";
import {
  parseEntityId,
  parseShortcodeFor,
  type GardenEntryId,
  type LocationId,
  type PlantingId,
} from "@cubby/schemas/identifiers";
import type { SortParams } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  gardenEntry,
  gardenEntryImage,
  ingredient,
  location,
  planting,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  applyImageOrder,
  imageJoinBindings,
  mapImages,
  type MappableImageRecord,
  notDeleted,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

type GardenDb = Database | DrizzleTransaction;

/** Shared dashboard/list predicate; garden records are always soft-delete scoped. */
export const buildPlantingWhere = () => notDeleted(planting);

/** Shared dashboard/list predicate; garden entries are always soft-delete scoped. */
export const buildGardenEntryWhere = () => notDeleted(gardenEntry);

const required = async <
  T extends "ingredient" | "location" | "planting" | "product",
>(
  db: GardenDb,
  shortcode: string,
  entity: T,
) => {
  const id = await resolveLiveShortcode(db, shortcode, entity);
  if (!id)
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      `The selected ${entity} no longer exists.`,
    );
  return parseEntityId(entity, id);
};

const plantingRow = async (db: GardenDb, id: PlantingId) => {
  const row = await unwrapDb(db).query.planting.findFirst({
    where: and(eq(planting.id, id), notDeleted(planting)),
    with: {
      ingredient: { columns: { shortcode: true } },
      sourceProduct: { columns: { shortcode: true } },
      location: { columns: { shortcode: true } },
      intendedLocation: { columns: { shortcode: true } },
      parentPlanting: { columns: { shortcode: true } },
    },
  });
  if (!row)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The planting no longer exists.",
    );
  return row;
};

type PlantingWithReferences = Awaited<ReturnType<typeof plantingRow>>;

const mapPlanting = (row: PlantingWithReferences) =>
  plantingOut.parse({
    ...row,
    id: parseShortcodeFor("planting", row.shortcode),
    ingredientId: parseShortcodeFor("ingredient", row.ingredient.shortcode),
    sourceProductId: row.sourceProduct
      ? parseShortcodeFor("product", row.sourceProduct.shortcode)
      : null,
    locationId: row.location
      ? parseShortcodeFor("location", row.location.shortcode)
      : null,
    intendedLocationId: row.intendedLocation
      ? parseShortcodeFor("location", row.intendedLocation.shortcode)
      : null,
    parentPlantingId: row.parentPlanting
      ? parseShortcodeFor("planting", row.parentPlanting.shortcode)
      : null,
  });

type GardenEntryWithReferences = typeof gardenEntry.$inferSelect & {
  location: { shortcode: string };
  planting: { shortcode: string } | null;
  images: Array<{ image: MappableImageRecord; deletedAt?: Date | null }>;
};

const mapEntry = (row: GardenEntryWithReferences) =>
  gardenEntryOut.parse({
    ...row,
    id: parseShortcodeFor("gardenEntry", row.shortcode),
    locationId: parseShortcodeFor("location", row.location.shortcode),
    plantingId: row.planting
      ? parseShortcodeFor("planting", row.planting.shortcode)
      : null,
    images: mapImages(row.images),
  });

export const getPlanting = async (db: GardenDb, id: PlantingId) =>
  mapPlanting(await plantingRow(db, id));

export const getGardenEntry = async (db: GardenDb, id: GardenEntryId) => {
  const row = await unwrapDb(db).query.gardenEntry.findFirst({
    where: and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
    with: {
      location: { columns: { shortcode: true } },
      planting: { columns: { shortcode: true } },
      images: { with: { image: true } },
    },
  });
  if (!row)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The garden entry no longer exists.",
    );
  return mapEntry(row);
};

export const createPlanting = async (
  db: Database,
  data: z.infer<typeof gardenCreatePlantingInput>,
  _actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const ingredientId = await required(tx, data.ingredientId, "ingredient");
    const locationId = data.locationId
      ? await required(tx, data.locationId, "location")
      : null;
    const intendedLocationId = data.intendedLocationId
      ? await required(tx, data.intendedLocationId, "location")
      : null;
    const sourceProductId = data.sourceProductId
      ? await required(tx, data.sourceProductId, "product")
      : null;
    if (data.status === "growing" && !locationId) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A growing planting needs a current location.",
      );
    }
    const row = await insertWithShortcode(tx, "planting", {
      ingredientId,
      locationId,
      intendedLocationId,
      sourceProductId,
      status: data.status,
      variety: data.variety ?? null,
      quantity: data.quantity ?? null,
      notes: data.notes ?? null,
      plannedWindow: data.plannedWindow ?? null,
      plannedDate: data.plannedDate ?? null,
      sowedOn: data.sowedOn ?? null,
      transplantedOn: data.transplantedOn ?? null,
      finishedOn: null,
      parentPlantingId: null,
    });
    await logAuditEntry(tx, _actor, {
      entityType: "planting",
      entityId: parseEntityId("planting", row.id),
      action: "create",
    });
    return getPlanting(tx, parseEntityId("planting", row.id));
  });

export const recordGardenEntry = async (
  db: Database,
  data: z.infer<typeof gardenRecordEntryInput>,
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const locationId = await required(tx, data.locationId, "location");
    const plantingId = data.plantingId
      ? await required(tx, data.plantingId, "planting")
      : null;
    const row = await insertWithShortcode(tx, "gardenEntry", {
      locationId,
      plantingId,
      kind: data.kind,
      observedOn: data.observedOn,
      note: data.note ?? null,
      harvestAmount: data.harvestAmount ?? null,
    });
    const imageIds = await resolveAllOrThrow(tx, "image", data.pendingImageIds);
    await associatePendingImages(
      tx,
      imageJoinBindings.gardenEntry,
      row.id,
      imageIds,
    );
    if (actor) {
      await logAuditEntry(tx, actor, {
        entityType: "gardenEntry",
        entityId: parseEntityId("gardenEntry", row.id),
        action: "create",
      });
    }
    return await getGardenEntry(tx, parseEntityId("gardenEntry", row.id));
  });

const moveEntry = async (
  tx: DrizzleTransaction,
  plantingId: PlantingId,
  locationId: LocationId,
  observedOn: string,
  note: string | null,
) =>
  insertWithShortcode(tx, "gardenEntry", {
    locationId,
    plantingId,
    kind: "move",
    observedOn,
    note,
    harvestAmount: null,
  });

const auditGardenChange = async (
  tx: DrizzleTransaction,
  actor: ActorContext | undefined,
  entityType: "planting" | "gardenEntry",
  entityId: string,
  action: "update",
) => {
  if (!actor) return;
  await logAuditEntry(tx, actor, { entityType, entityId, action });
};

export const startPlanting = async (
  db: Database,
  input: {
    plantingId: string;
    locationId: string;
    startedOn: string;
    startMethod: "sow" | "transplant" | "existing";
  },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const id = await required(tx, input.plantingId, "planting");
    const locationId = await required(tx, input.locationId, "location");
    const current = await plantingRow(tx, id);
    if (current.status !== "planned") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only a planned planting can be started.",
      );
    }
    const dates =
      input.startMethod === "sow"
        ? { sowedOn: current.sowedOn ?? input.startedOn }
        : input.startMethod === "transplant"
          ? { transplantedOn: current.transplantedOn ?? input.startedOn }
          : {};
    await tx
      .update(planting)
      .set({ status: "growing", locationId, ...dates })
      .where(eq(planting.id, id));
    await insertWithShortcode(tx, "gardenEntry", {
      locationId,
      plantingId: id,
      kind: "observation",
      observedOn: input.startedOn,
      note:
        input.startMethod === "sow"
          ? "Started from seed"
          : input.startMethod === "transplant"
            ? "Transplanted"
            : "Recorded existing planting",
      harvestAmount: null,
    });
    await auditGardenChange(tx, actor, "planting", id, "update");
    return getPlanting(tx, id);
  });

export const movePlanting = async (
  db: Database,
  input: {
    plantingId: string;
    locationId: string;
    movedOn: string;
    note?: string | null;
  },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const id = await required(tx, input.plantingId, "planting");
    const locationId = await required(tx, input.locationId, "location");
    const current = await plantingRow(tx, id);
    if (current.status !== "growing") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only a growing planting can be moved.",
      );
    }
    await tx
      .update(planting)
      .set({
        locationId,
        status: "growing",
        transplantedOn: current.transplantedOn ?? input.movedOn,
      })
      .where(eq(planting.id, id));
    await moveEntry(tx, id, locationId, input.movedOn, input.note ?? null);
    await auditGardenChange(tx, actor, "planting", id, "update");
    return getPlanting(tx, id);
  });

export const splitPlanting = async (
  db: Database,
  input: {
    plantingId: string;
    locationId: string;
    movedOn: string;
    quantity?: string | null;
    note?: string | null;
  },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const parentId = await required(tx, input.plantingId, "planting");
    const locationId = await required(tx, input.locationId, "location");
    const parent = await plantingRow(tx, parentId);
    if (parent.status !== "growing") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Only a growing planting can be split.",
      );
    }
    const child = await insertWithShortcode(tx, "planting", {
      ingredientId: parent.ingredientId,
      sourceProductId: parent.sourceProductId,
      locationId,
      intendedLocationId: parent.intendedLocationId,
      parentPlantingId: parentId,
      status: "growing",
      variety: parent.variety,
      quantity: input.quantity ?? null,
      notes: parent.notes,
      plannedWindow: parent.plannedWindow,
      plannedDate: parent.plannedDate,
      sowedOn: parent.sowedOn,
      transplantedOn: input.movedOn,
      finishedOn: null,
    });
    await moveEntry(
      tx,
      parseEntityId("planting", child.id),
      locationId,
      input.movedOn,
      input.note ?? null,
    );
    if (actor) {
      await logAuditEntry(tx, actor, {
        entityType: "planting",
        entityId: parseEntityId("planting", child.id),
        action: "create",
      });
    }
    return getPlanting(tx, parseEntityId("planting", child.id));
  });

export const finishPlanting = async (
  db: Database,
  input: { plantingId: string; finishedOn: string; note?: string | null },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const id = await required(tx, input.plantingId, "planting");
    const current = await plantingRow(tx, id);
    await tx
      .update(planting)
      .set({ status: "finished", finishedOn: input.finishedOn })
      .where(eq(planting.id, id));
    if (input.note && current.locationId) {
      await insertWithShortcode(tx, "gardenEntry", {
        locationId: current.locationId,
        plantingId: id,
        kind: "observation",
        observedOn: input.finishedOn,
        note: input.note,
        harvestAmount: null,
      });
    }
    await auditGardenChange(tx, actor, "planting", id, "update");
    return getPlanting(tx, id);
  });

/** Ordinary edits deliberately cannot change lifecycle or current location. */
export const updatePlantingDetails = async (
  db: Database,
  id: PlantingId,
  data: {
    ingredientId?: string;
    sourceProductId?: string | null;
    intendedLocationId?: string | null;
    variety?: string | null;
    quantity?: string | null;
    notes?: string | null;
    plannedWindow?: string | null;
    plannedDate?: string | null;
    sowedOn?: string | null;
    transplantedOn?: string | null;
    locationId?: unknown;
    status?: unknown;
    finishedOn?: unknown;
  },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    if (
      data.locationId !== undefined ||
      data.status !== undefined ||
      data.finishedOn !== undefined
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Use the start, move, or finish action to change a planting's lifecycle or location.",
      );
    }
    const patch: Partial<typeof planting.$inferInsert> = {
      variety: data.variety,
      quantity: data.quantity,
      notes: data.notes,
      plannedWindow: data.plannedWindow,
      plannedDate: data.plannedDate,
      sowedOn: data.sowedOn,
      transplantedOn: data.transplantedOn,
    };
    if (data.ingredientId !== undefined) {
      patch.ingredientId = await required(tx, data.ingredientId, "ingredient");
    }
    if (data.sourceProductId !== undefined) {
      patch.sourceProductId = data.sourceProductId
        ? await required(tx, data.sourceProductId, "product")
        : null;
    }
    if (data.intendedLocationId !== undefined) {
      patch.intendedLocationId = data.intendedLocationId
        ? await required(tx, data.intendedLocationId, "location")
        : null;
    }
    await tx.update(planting).set(patch).where(eq(planting.id, id));
    await auditGardenChange(tx, actor, "planting", id, "update");
    return getPlanting(tx, id);
  });

export const updateGardenEntryDetails = async (
  db: Database,
  id: GardenEntryId,
  data: {
    locationId?: unknown;
    plantingId?: unknown;
    kind?: "observation" | "harvest" | "move";
    observedOn?: string;
    note?: string | null;
    harvestAmount?: string | null;
    pendingImageIds?: string[];
    removeImageIds?: string[];
    imageOrder?: string[];
  },
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const current = await unwrapDb(tx).query.gardenEntry.findFirst({
      where: and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
      with: {
        location: { columns: { shortcode: true } },
        planting: { columns: { shortcode: true } },
      },
    });
    if (!current) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The garden entry no longer exists.",
      );
    }
    const currentLocationId = parseShortcodeFor(
      "location",
      current.location.shortcode,
    );
    const currentPlantingId = current.planting
      ? parseShortcodeFor("planting", current.planting.shortcode)
      : null;
    if (
      (data.locationId !== undefined &&
        data.locationId !== currentLocationId) ||
      (data.plantingId !== undefined && data.plantingId !== currentPlantingId)
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A garden entry keeps the crop and location where it happened.",
      );
    }
    if (
      data.kind !== undefined &&
      (data.kind === "move") !== (current.kind === "move")
    ) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Move entries are created only by planting workflows.",
      );
    }
    await tx
      .update(gardenEntry)
      .set({
        observedOn: data.observedOn ?? current.observedOn,
        note: data.note === undefined ? current.note : data.note,
        harvestAmount:
          data.harvestAmount === undefined
            ? current.harvestAmount
            : data.harvestAmount,
        kind: data.kind ?? gardenEntryKind.parse(current.kind),
      })
      .where(eq(gardenEntry.id, id));
    if (data.pendingImageIds?.length) {
      const imageIds = await resolveAllOrThrow(
        tx,
        "image",
        data.pendingImageIds,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.gardenEntry,
        id,
        imageIds,
      );
    }
    if (data.removeImageIds?.length) {
      const imageIds = await resolveAllOrThrow(
        tx,
        "image",
        data.removeImageIds,
      );
      await tx
        .update(gardenEntryImage)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(gardenEntryImage.gardenEntryId, id),
            inArray(gardenEntryImage.imageId, imageIds),
            notDeleted(gardenEntryImage),
          ),
        );
    }
    if (data.imageOrder?.length) {
      const imageIds = await resolveAllOrThrow(tx, "image", data.imageOrder);
      await applyImageOrder(tx, imageJoinBindings.gardenEntry, id, imageIds);
    }
    await auditGardenChange(tx, actor, "gardenEntry", id, "update");
    return getGardenEntry(tx, id);
  });

export const plantingList = async (
  db: Database,
  pagination: { page: number; pageSize: number },
  sorts: SortParams[] = [],
) => {
  const sort = sorts[0];
  const order =
    sort?.orderBy === "updatedAt"
      ? sort.direction === "asc"
        ? asc(planting.updatedAt)
        : desc(planting.updatedAt)
      : sort?.direction === "asc"
        ? asc(planting.createdAt)
        : desc(planting.createdAt);
  const rows = await unwrapDb(db).query.planting.findMany({
    where: buildPlantingWhere(),
    with: {
      ingredient: { columns: { shortcode: true } },
      sourceProduct: { columns: { shortcode: true } },
      location: { columns: { shortcode: true } },
      intendedLocation: { columns: { shortcode: true } },
      parentPlanting: { columns: { shortcode: true } },
    },
    orderBy: [order],
    limit: pagination.pageSize,
    offset: (pagination.page - 1) * pagination.pageSize,
  });
  const countRow = (
    await unwrapDb(db)
      .select({ count: sql<number>`count(*)` })
      .from(planting)
      .where(buildPlantingWhere())
  )[0];
  return { data: rows.map(mapPlanting), count: Number(countRow?.count ?? 0) };
};

export const gardenEntryList = async (
  db: Database,
  pagination: { page: number; pageSize: number },
  sorts: SortParams[] = [],
) => {
  const sort = sorts[0];
  const order =
    sort?.orderBy === "createdAt"
      ? sort.direction === "asc"
        ? asc(gardenEntry.createdAt)
        : desc(gardenEntry.createdAt)
      : sort?.direction === "asc"
        ? asc(gardenEntry.observedOn)
        : desc(gardenEntry.observedOn);
  const rows = await unwrapDb(db).query.gardenEntry.findMany({
    where: buildGardenEntryWhere(),
    with: {
      location: { columns: { shortcode: true } },
      planting: { columns: { shortcode: true } },
      images: { with: { image: true } },
    },
    orderBy: [order, desc(gardenEntry.createdAt)],
    limit: pagination.pageSize,
    offset: (pagination.page - 1) * pagination.pageSize,
  });
  const countRow = (
    await unwrapDb(db)
      .select({ count: sql<number>`count(*)` })
      .from(gardenEntry)
      .where(buildGardenEntryWhere())
  )[0];
  return { data: rows.map(mapEntry), count: Number(countRow?.count ?? 0) };
};

export const gardenOverview = async (db: Database) => {
  const currentLocation = alias(location, "GardenCurrentLocation");
  const intendedLocation = alias(location, "GardenIntendedLocation");
  const parentPlanting = alias(planting, "GardenParentPlanting");
  const [locations, rows] = await Promise.all([
    unwrapDb(db)
      .select()
      .from(location)
      .where(notDeleted(location))
      .orderBy(asc(location.name)),
    unwrapDb(db)
      .select({
        row: planting,
        ingredientName: ingredient.name,
        gardenGuideKey: ingredient.gardenGuideKey,
        ingredientShortcode: ingredient.shortcode,
        sourceProductName: product.name,
        sourceProductShortcode: product.shortcode,
        locationName: currentLocation.name,
        locationShortcode: currentLocation.shortcode,
        intendedLocationName: intendedLocation.name,
        intendedLocationShortcode: intendedLocation.shortcode,
        parentPlantingShortcode: parentPlanting.shortcode,
      })
      .from(planting)
      .innerJoin(ingredient, eq(planting.ingredientId, ingredient.id))
      .leftJoin(product, eq(planting.sourceProductId, product.id))
      .leftJoin(currentLocation, eq(planting.locationId, currentLocation.id))
      .leftJoin(
        intendedLocation,
        eq(planting.intendedLocationId, intendedLocation.id),
      )
      .leftJoin(
        parentPlanting,
        eq(planting.parentPlantingId, parentPlanting.id),
      )
      .where(notDeleted(planting))
      .orderBy(desc(planting.createdAt)),
  ]);
  const enriched = rows.map((item) => ({
    ...plantingOut.parse({
      ...item.row,
      id: parseShortcodeFor("planting", item.row.shortcode),
      ingredientId: parseShortcodeFor("ingredient", item.ingredientShortcode),
      sourceProductId: item.sourceProductShortcode
        ? parseShortcodeFor("product", item.sourceProductShortcode)
        : null,
      locationId: item.locationShortcode
        ? parseShortcodeFor("location", item.locationShortcode)
        : null,
      intendedLocationId: item.intendedLocationShortcode
        ? parseShortcodeFor("location", item.intendedLocationShortcode)
        : null,
      parentPlantingId: item.parentPlantingShortcode
        ? parseShortcodeFor("planting", item.parentPlantingShortcode)
        : null,
    }),
    ingredientName: item.ingredientName,
    gardenGuideKey: item.gardenGuideKey,
    sourceProductName: item.sourceProductName,
    locationName: item.locationName,
    intendedLocationName: item.intendedLocationName,
  })) satisfies GardenPlantingOut[];
  return gardenOverviewOut.parse({
    locations: locations
      .filter((place) => {
        const id = parseShortcodeFor("location", place.shortcode);
        return (
          place.gardenKind !== null ||
          enriched.some(
            (entry) =>
              entry.locationId === id || entry.intendedLocationId === id,
          )
        );
      })
      .map((place) => {
        const id = parseShortcodeFor("location", place.shortcode);
        return {
          id,
          name: place.name,
          gardenKind: gardenLocationKind.nullable().parse(place.gardenKind),
          gardenConditions: place.gardenConditions,
          plantings: enriched.filter(
            (entry) =>
              entry.status !== "finished" &&
              (entry.locationId === id ||
                (entry.status === "planned" &&
                  !entry.locationId &&
                  entry.intendedLocationId === id)),
          ),
        };
      }),
    finished: enriched.filter((entry) => entry.status === "finished"),
    unassigned: enriched.filter(
      (entry) =>
        entry.status !== "finished" &&
        !entry.locationId &&
        !entry.intendedLocationId,
    ),
  });
};

export const gardenEntries = async (
  db: Database,
  input: { locationId?: string; plantingId?: string; page: number },
) => {
  const locationId = input.locationId
    ? await required(db, input.locationId, "location")
    : null;
  const plantingId = input.plantingId
    ? await required(db, input.plantingId, "planting")
    : null;
  const pageSize = 50;
  const rows = await unwrapDb(db).query.gardenEntry.findMany({
    where: and(
      notDeleted(gardenEntry),
      ...(locationId ? [eq(gardenEntry.locationId, locationId)] : []),
      ...(plantingId ? [eq(gardenEntry.plantingId, plantingId)] : []),
    ),
    with: {
      location: { columns: { shortcode: true } },
      planting: { columns: { shortcode: true } },
      images: { with: { image: true } },
    },
    orderBy: [desc(gardenEntry.observedOn), desc(gardenEntry.createdAt)],
    limit: pageSize + 1,
    offset: (input.page - 1) * pageSize,
  });
  return {
    items: rows.slice(0, pageSize).map((row) => mapEntry(row)),
    hasMore: rows.length > pageSize,
  };
};

export const gardenOptions = async (db: Database) => {
  const [locations, ingredients, products] = await Promise.all([
    unwrapDb(db)
      .select({
        shortcode: location.shortcode,
        name: location.name,
        gardenKind: location.gardenKind,
        gardenConditions: location.gardenConditions,
      })
      .from(location)
      .where(notDeleted(location))
      .orderBy(asc(location.name)),
    unwrapDb(db)
      .select({
        shortcode: ingredient.shortcode,
        name: ingredient.name,
        gardenGuideKey: ingredient.gardenGuideKey,
      })
      .from(ingredient)
      .where(notDeleted(ingredient))
      .orderBy(asc(ingredient.name)),
    unwrapDb(db)
      .select({
        shortcode: product.shortcode,
        name: product.name,
        growsIngredientShortcode: ingredient.shortcode,
      })
      .from(product)
      .leftJoin(ingredient, eq(product.growsIngredientId, ingredient.id))
      .where(notDeleted(product))
      .orderBy(asc(product.name)),
  ]);
  return gardenOptionsOut.parse({
    locations: locations.map((row) => ({
      id: parseShortcodeFor("location", row.shortcode),
      name: row.name,
      gardenKind: row.gardenKind,
      gardenConditions: row.gardenConditions,
    })),
    ingredients: ingredients.map((row) => ({
      id: parseShortcodeFor("ingredient", row.shortcode),
      name: row.name,
      gardenGuideKey: row.gardenGuideKey,
    })),
    products: products.map((row) => ({
      id: parseShortcodeFor("product", row.shortcode),
      name: row.name,
      growsIngredientId: row.growsIngredientShortcode
        ? parseShortcodeFor("ingredient", row.growsIngredientShortcode)
        : null,
    })),
  });
};

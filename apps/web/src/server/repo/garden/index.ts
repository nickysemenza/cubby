import type { ActorContext } from "@cubby/schemas/context";
import {
  type GardenPlantingOut,
  gardenCreatePlantingInput,
  gardenCorrectLocationDatesInput,
  gardenEntryKind,
  gardenJournalInput,
  gardenJournalOut,
  gardenLocationHistoryInput,
  gardenLocationHistoryOut,
  gardenLocationKind,
  gardenPlantingOut,
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
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { and, asc, desc, eq, exists, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  gardenEntry,
  ingredient,
  location,
  planting,
  plantingLocationPeriod,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  countWhere,
  executeListQueryWithCount,
  imageJoinBindings,
  mapImages,
  type MappableImageRecord,
  notDeleted,
  plantingImagesRelation,
  syncEntityImages,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  resolveAllOrThrow,
  resolveAllPresent,
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
      images: plantingImagesRelation,
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
    images: mapImages(row.images),
  });

type GardenEntryWithReferences = typeof gardenEntry.$inferSelect & {
  location: { shortcode: string; name: string };
  planting: {
    shortcode: string;
    variety: string | null;
    ingredient: { name: string };
  } | null;
  images: Array<{ image: MappableImageRecord; deletedAt?: Date | null }>;
};

const plantingDisplayName = (
  row: NonNullable<GardenEntryWithReferences["planting"]>,
) =>
  row.variety ? `${row.ingredient.name} (${row.variety})` : row.ingredient.name;

const mapEntry = (row: GardenEntryWithReferences) =>
  gardenEntryOut.parse({
    ...row,
    id: parseShortcodeFor("gardenEntry", row.shortcode),
    locationId: parseShortcodeFor("location", row.location.shortcode),
    plantingId: row.planting
      ? parseShortcodeFor("planting", row.planting.shortcode)
      : null,
    locationName: row.location.name,
    plantingName: row.planting ? plantingDisplayName(row.planting) : null,
    images: mapImages(row.images),
  });

export const getPlanting = async (db: GardenDb, id: PlantingId) =>
  mapPlanting(await plantingRow(db, id));

export const getGardenEntry = async (db: GardenDb, id: GardenEntryId) => {
  const row = await unwrapDb(db).query.gardenEntry.findFirst({
    where: and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
    with: {
      location: { columns: { shortcode: true, name: true } },
      planting: {
        columns: { shortcode: true, variety: true },
        with: { ingredient: { columns: { name: true } } },
      },
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

// `gardenCreatePlantingInput` (the dedicated garden-form workflow input)
// doesn't itself carry `pendingImageIds` — the generic entity-kernel
// `planting.create` path does (the generated `PlantingCreateInput`), and both
// funnel through this one function. Optional here so a caller without it
// (the garden form) is unaffected.
type CreatePlantingData = z.input<typeof gardenCreatePlantingInput> & {
  pendingImageIds?: readonly string[];
};

const plantingCreateReferences = async (
  tx: DrizzleTransaction,
  data: CreatePlantingData,
) => ({
  ingredientId: await required(tx, data.ingredientId, "ingredient"),
  locationId: data.locationId
    ? await required(tx, data.locationId, "location")
    : null,
  intendedLocationId: data.intendedLocationId
    ? await required(tx, data.intendedLocationId, "location")
    : null,
  sourceProductId: data.sourceProductId
    ? await required(tx, data.sourceProductId, "product")
    : null,
});

const assertPlantingCreateLocation = (
  data: CreatePlantingData,
  locationId: LocationId | null,
) => {
  if (data.status === "growing" && !locationId) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A growing planting needs a current location.",
    );
  }
  if (data.inLocationSince && (!locationId || data.status !== "growing")) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A location start date needs a growing planting in a current location.",
    );
  }
};

const addInitialLocationPeriod = async (
  tx: DrizzleTransaction,
  plantingId: PlantingId,
  locationId: LocationId | null,
  data: CreatePlantingData,
) => {
  if (locationId && data.status === "growing") {
    await addLocationPeriod(tx, {
      plantingId,
      locationId,
      inLocationSince: data.inLocationSince ?? householdLocalDate(),
      startKind: data.inLocationSince
        ? (data.inLocationSinceKind ?? "actual")
        : "recorded",
    });
  }
};

export const createPlanting = async (
  db: Database,
  data: CreatePlantingData,
  _actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const references = await plantingCreateReferences(tx, data);
    assertPlantingCreateLocation(data, references.locationId);
    const row = await insertWithShortcode(tx, "planting", {
      ...references,
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
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      const resolvedImageIds = await resolveAllPresent(
        tx,
        "image",
        data.pendingImageIds,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.planting,
        parseEntityId("planting", row.id),
        resolvedImageIds,
      );
    }
    await logAuditEntry(tx, _actor, {
      entityType: "planting",
      entityId: parseEntityId("planting", row.id),
      action: "create",
    });
    const plantingId = parseEntityId("planting", row.id);
    await addInitialLocationPeriod(tx, plantingId, references.locationId, data);
    return getPlanting(tx, plantingId);
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

const locationPeriodsFor = (db: GardenDb, plantingId: PlantingId) =>
  unwrapDb(db).query.plantingLocationPeriod.findMany({
    where: eq(plantingLocationPeriod.plantingId, plantingId),
    with: { location: { columns: { shortcode: true, name: true } } },
    orderBy: [asc(plantingLocationPeriod.sequence)],
  });

const mapLocationHistory = async (db: GardenDb, plantingId: PlantingId) =>
  gardenLocationHistoryOut.parse({
    periods: (await locationPeriodsFor(db, plantingId)).map((period) => ({
      sequence: period.sequence,
      locationId: parseShortcodeFor("location", period.location.shortcode),
      locationName: period.location.name,
      inLocationSince: period.inLocationSince,
      endedOn: period.endedOn,
      startKind: period.startKind,
    })),
  });

const addLocationPeriod = async (
  tx: DrizzleTransaction,
  input: {
    plantingId: PlantingId;
    locationId: LocationId;
    inLocationSince: string;
    startKind: "actual" | "recorded";
    sourceGardenEntryId?: GardenEntryId | null;
  },
) => {
  const previous = await unwrapDb(tx).query.plantingLocationPeriod.findFirst({
    where: eq(plantingLocationPeriod.plantingId, input.plantingId),
    columns: { sequence: true },
    orderBy: [desc(plantingLocationPeriod.sequence)],
  });
  await tx.insert(plantingLocationPeriod).values({
    ...input,
    sequence: (previous?.sequence ?? -1) + 1,
    endedOn: null,
    sourceGardenEntryId: input.sourceGardenEntryId ?? null,
  });
};

const closeOpenLocationPeriod = async (
  tx: DrizzleTransaction,
  plantingId: PlantingId,
  endedOn: string,
) => {
  const openPeriod = await unwrapDb(tx).query.plantingLocationPeriod.findFirst({
    where: and(
      eq(plantingLocationPeriod.plantingId, plantingId),
      isNull(plantingLocationPeriod.endedOn),
    ),
    columns: { inLocationSince: true },
  });
  if (openPeriod && endedOn < openPeriod.inLocationSince) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A location transition cannot happen before the current location began.",
    );
  }
  await tx
    .update(plantingLocationPeriod)
    .set({ endedOn })
    .where(
      and(
        eq(plantingLocationPeriod.plantingId, plantingId),
        isNull(plantingLocationPeriod.endedOn),
      ),
    );
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
    const startEntry = await insertWithShortcode(tx, "gardenEntry", {
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
    await addLocationPeriod(tx, {
      plantingId: id,
      locationId,
      inLocationSince: input.startedOn,
      startKind: input.startMethod === "existing" ? "recorded" : "actual",
      sourceGardenEntryId: parseEntityId("gardenEntry", startEntry.id),
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
    await closeOpenLocationPeriod(tx, id, input.movedOn);
    const entry = await moveEntry(
      tx,
      id,
      locationId,
      input.movedOn,
      input.note ?? null,
    );
    await addLocationPeriod(tx, {
      plantingId: id,
      locationId,
      inLocationSince: input.movedOn,
      startKind: "actual",
      sourceGardenEntryId: parseEntityId("gardenEntry", entry.id),
    });
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
    const entry = await moveEntry(
      tx,
      parseEntityId("planting", child.id),
      locationId,
      input.movedOn,
      input.note ?? null,
    );
    await addLocationPeriod(tx, {
      plantingId: parseEntityId("planting", child.id),
      locationId,
      inLocationSince: input.movedOn,
      startKind: "actual",
      sourceGardenEntryId: parseEntityId("gardenEntry", entry.id),
    });
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
    // `planned` is deliberately allowed (the UI offers Finish for every
    // non-finished planting); a second finish would silently move the date.
    if (current.status === "finished") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "This planting is already finished.",
      );
    }
    await tx
      .update(planting)
      .set({ status: "finished", finishedOn: input.finishedOn })
      .where(eq(planting.id, id));
    await closeOpenLocationPeriod(tx, id, input.finishedOn);
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
    pendingImageIds?: readonly string[];
    removeImageIds?: readonly string[];
    imageOrder?: readonly string[];
  },
  actor?: ActorContext,
) => {
  let detachedImageKeys: string[] = [];
  const result = await withTransaction(db, async (tx) => {
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
    ({ detachedImageKeys } = await syncEntityImages(
      tx,
      "planting",
      imageJoinBindings.planting,
      id,
      data,
    ));
    await auditGardenChange(tx, actor, "planting", id, "update");
    return getPlanting(tx, id);
  });
  return { planting: result, detachedImageKeys };
};

type GardenEntryUpdateDetails = {
  locationId?: string;
  plantingId?: string | null;
  kind?: "observation" | "harvest" | "move";
  observedOn?: string;
  note?: string | null;
  harvestAmount?: string | null;
  pendingImageIds?: string[];
  removeImageIds?: string[];
  imageOrder?: string[];
};

/** Shared with `entity-adapters.ts`'s generic-create guard: a `move` entry is
 * a byproduct of a planting workflow (start/move/split), never a direct
 * create or retype. */
export const MOVE_ENTRY_MESSAGE =
  "Move entries are created only by planting workflows.";

const assertGardenEntryStructure = (
  current: { kind: string; anchorsPeriod: boolean },
  data: GardenEntryUpdateDetails,
) => {
  const editsMoveStructure =
    data.locationId !== undefined ||
    data.plantingId !== undefined ||
    data.observedOn !== undefined;
  // Keyed off the period, not only `kind`: the bootstrapping entry that
  // `startPlanting` writes is an `observation` and anchors a period too.
  if (
    (current.kind === "move" || current.anchorsPeriod) &&
    editsMoveStructure
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Use location history to correct a structural move.",
    );
  }
  // Only `move` is structural; an observation may be retyped as a harvest
  // (and back) like any other correction.
  if (
    data.kind !== undefined &&
    data.kind !== current.kind &&
    (data.kind === "move" || current.kind === "move")
  ) {
    throw createAppError("CONSTRAINT_VIOLATION", MOVE_ENTRY_MESSAGE);
  }
};

const updateGardenEntryImages = async (
  tx: DrizzleTransaction,
  id: GardenEntryId,
  data: GardenEntryUpdateDetails,
): Promise<string[]> => {
  // `unresolved: "throw"` — a caller-supplied `IMG-` code that doesn't
  // resolve is bad input here, unlike product/location/recipe/purchase's
  // silent-drop convention.
  const { detachedImageKeys } = await syncEntityImages(
    tx,
    "gardenEntry",
    imageJoinBindings.gardenEntry,
    id,
    data,
    { unresolved: "throw" },
  );
  return detachedImageKeys;
};

export const updateGardenEntryDetails = async (
  db: Database,
  id: GardenEntryId,
  data: GardenEntryUpdateDetails,
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
    const anchor = await unwrapDb(tx).query.plantingLocationPeriod.findFirst({
      where: eq(plantingLocationPeriod.sourceGardenEntryId, id),
      columns: { sourceGardenEntryId: true },
    });
    assertGardenEntryStructure(
      { kind: current.kind, anchorsPeriod: anchor !== undefined },
      data,
    );
    const locationId =
      data.locationId === undefined
        ? current.locationId
        : await required(tx, data.locationId, "location");
    const plantingId =
      data.plantingId === undefined
        ? current.plantingId
        : data.plantingId
          ? await required(tx, data.plantingId, "planting")
          : null;
    await tx
      .update(gardenEntry)
      .set({
        locationId,
        plantingId,
        observedOn: data.observedOn ?? current.observedOn,
        note: data.note === undefined ? current.note : data.note,
        harvestAmount:
          data.harvestAmount === undefined
            ? current.harvestAmount
            : data.harvestAmount,
        kind: data.kind ?? gardenEntryKind.parse(current.kind),
      })
      .where(eq(gardenEntry.id, id));
    await updateGardenEntryImages(tx, id, data);
    await auditGardenChange(tx, actor, "gardenEntry", id, "update");
    return getGardenEntry(tx, id);
  });

const plantingScaffold = listScaffold("planting", planting);

export const plantingList = async (
  db: Database,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  const where = buildPlantingWhere();
  const orderByArray = plantingScaffold.orderBy(sorts);
  const { take, skip } = plantingScaffold.page(pagination);
  const { data: rows, count } = await executeListQueryWithCount({
    kind: "page",
    rows: () =>
      unwrapDb(db).query.planting.findMany({
        where,
        with: {
          ingredient: { columns: { shortcode: true } },
          sourceProduct: { columns: { shortcode: true } },
          location: { columns: { shortcode: true } },
          intendedLocation: { columns: { shortcode: true } },
          parentPlanting: { columns: { shortcode: true } },
          images: plantingImagesRelation,
        },
        orderBy: orderByArray,
        limit: take,
        offset: skip,
      }),
    count: () => countWhere(db, planting, where),
  });
  const items = await withDisplayImages(db, "planting", rows, mapPlanting);
  return { data: items, count };
};

const gardenEntryScaffold = listScaffold("gardenEntry", gardenEntry);

export const gardenEntryList = async (
  db: Database,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  const where = buildGardenEntryWhere();
  // `createdAt desc` is a deliberate stable tiebreak (was hard-coded as a
  // second `orderBy` entry alongside whichever field the caller picked) — a
  // `tieBreaker`, not a `resolve` special-case, so it can't swallow a second
  // user-requested sort (see `buildOrderBy`'s doc comment).
  const orderByArray = gardenEntryScaffold.orderBy(sorts, {
    tieBreaker: desc(gardenEntry.createdAt),
  });
  const { take, skip } = gardenEntryScaffold.page(pagination);
  const { data: rows, count } = await executeListQueryWithCount({
    kind: "page",
    rows: () =>
      unwrapDb(db).query.gardenEntry.findMany({
        where,
        with: {
          location: { columns: { shortcode: true, name: true } },
          planting: {
            columns: { shortcode: true, variety: true },
            with: { ingredient: { columns: { name: true } } },
          },
          images: { with: { image: true } },
        },
        orderBy: orderByArray,
        limit: take,
        offset: skip,
      }),
    count: () => countWhere(db, gardenEntry, where),
  });
  return {
    data: await withDisplayImages(db, "gardenEntry", rows, mapEntry),
    count,
  };
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
  // `gardenPlantingOut` (not `plantingOut`) on purpose: this raw joined select
  // has no `PlantingImage` relation loaded, so a schema requiring `images`
  // would fail to parse every row.
  const enriched = rows.map((item) =>
    gardenPlantingOut.parse({
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
      ingredientName: item.ingredientName,
      gardenGuideKey: item.gardenGuideKey,
      sourceProductName: item.sourceProductName,
      locationName: item.locationName,
      intendedLocationName: item.intendedLocationName,
    }),
  ) satisfies GardenPlantingOut[];
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
      location: { columns: { shortcode: true, name: true } },
      planting: {
        columns: { shortcode: true, variety: true },
        with: { ingredient: { columns: { name: true } } },
      },
      images: { with: { image: true } },
    },
    orderBy: [
      desc(gardenEntry.observedOn),
      desc(gardenEntry.createdAt),
      desc(gardenEntry.id),
    ],
    limit: pageSize + 1,
    offset: (input.page - 1) * pageSize,
  });
  return {
    items: rows.slice(0, pageSize).map((row) => mapEntry(row)),
    hasMore: rows.length > pageSize,
  };
};

/**
 * A planting journal always includes its direct entries. Whole-location
 * entries join only when their observation date falls in a confirmed period.
 */
export const gardenJournal = async (
  db: Database,
  input: z.infer<typeof gardenJournalInput>,
) => {
  const plantingId = await required(db, input.plantingId, "planting");
  const pageSize = 50;
  const inConfirmedLocationPeriod = exists(
    unwrapDb(db)
      .select({ one: sql`1` })
      .from(plantingLocationPeriod)
      .where(
        and(
          eq(plantingLocationPeriod.plantingId, plantingId),
          sql`${plantingLocationPeriod.locationId} = ${sql.raw('"gardenEntry"."locationId"')}`,
          sql`${sql.raw('"gardenEntry"."observedOn"')} >= ${plantingLocationPeriod.inLocationSince}`,
          or(
            isNull(plantingLocationPeriod.endedOn),
            sql`${sql.raw('"gardenEntry"."observedOn"')} <= ${plantingLocationPeriod.endedOn}`,
          ),
        ),
      ),
  );
  const rows = await unwrapDb(db).query.gardenEntry.findMany({
    where: and(
      notDeleted(gardenEntry),
      input.includeBedContext
        ? or(
            eq(gardenEntry.plantingId, plantingId),
            and(isNull(gardenEntry.plantingId), inConfirmedLocationPeriod),
          )
        : eq(gardenEntry.plantingId, plantingId),
    ),
    with: {
      location: { columns: { shortcode: true, name: true } },
      planting: {
        columns: { shortcode: true, variety: true },
        with: { ingredient: { columns: { name: true } } },
      },
      images: { with: { image: true } },
    },
    orderBy: [
      desc(gardenEntry.observedOn),
      desc(gardenEntry.createdAt),
      desc(gardenEntry.id),
    ],
    limit: pageSize + 1,
    offset: (input.page - 1) * pageSize,
  });
  return gardenJournalOut.parse({
    items: rows.slice(0, pageSize).map((row) => ({
      ...mapEntry(row),
      context: row.plantingId === plantingId ? "direct" : "bed",
    })),
    hasMore: rows.length > pageSize,
  });
};

export const gardenLocationHistory = async (
  db: Database,
  input: z.infer<typeof gardenLocationHistoryInput>,
) => {
  const plantingId = await required(db, input.plantingId, "planting");
  return mapLocationHistory(db, plantingId);
};

type StoredLocationPeriod = Pick<
  typeof plantingLocationPeriod.$inferSelect,
  | "id"
  | "sequence"
  | "inLocationSince"
  | "endedOn"
  | "startKind"
  | "sourceGardenEntryId"
>;
type SubmittedLocationPeriod = z.infer<
  typeof gardenCorrectLocationDatesInput
>["periods"][number];

const assertLocationCorrectionMatches = (
  existing: StoredLocationPeriod[],
  submitted: SubmittedLocationPeriod[],
) => {
  if (
    existing.length !== submitted.length ||
    existing.some(
      (period, index) => period.sequence !== submitted[index]?.sequence,
    )
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Location history changed; reload it before correcting dates.",
    );
  }
};

const assertLocationPeriodDates = (
  status: string,
  periods: SubmittedLocationPeriod[],
) => {
  for (const [index, period] of periods.entries()) {
    const isLast = index === periods.length - 1;
    if (period.endedOn && period.endedOn < period.inLocationSince) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A location period cannot end before it starts.",
      );
    }
    if (!isLast && period.endedOn !== periods[index + 1]?.inLocationSince) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A move's source end and destination start must be the same date.",
      );
    }
    if (isLast && status === "growing" && period.endedOn !== null) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The active location period must remain open.",
      );
    }
    if (isLast && status === "finished" && !period.endedOn) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A finished planting's final location period must be closed.",
      );
    }
  }
};

const applyLocationPeriodCorrections = async (
  tx: DrizzleTransaction,
  existing: StoredLocationPeriod[],
  submitted: SubmittedLocationPeriod[],
) => {
  for (const [index, period] of submitted.entries()) {
    const existingPeriod = existing[index];
    if (!existingPeriod) continue;
    const datesChanged =
      existingPeriod.inLocationSince !== period.inLocationSince ||
      existingPeriod.endedOn !== (period.endedOn ?? null);
    await tx
      .update(plantingLocationPeriod)
      .set({
        inLocationSince: period.inLocationSince,
        endedOn: period.endedOn ?? null,
        startKind: datesChanged ? "actual" : existingPeriod.startKind,
      })
      .where(eq(plantingLocationPeriod.id, existingPeriod.id));
    if (existingPeriod.sourceGardenEntryId && datesChanged) {
      await tx
        .update(gardenEntry)
        .set({ observedOn: period.inLocationSince })
        .where(eq(gardenEntry.id, existingPeriod.sourceGardenEntryId));
    }
  }
};

const bootstrapConfirmedLocationPeriod = async (
  tx: DrizzleTransaction,
  plantingId: PlantingId,
  plantingState: Awaited<ReturnType<typeof plantingRow>>,
  submitted: SubmittedLocationPeriod[],
) => {
  if (
    plantingState.status === "planned" ||
    !plantingState.locationId ||
    submitted.length !== 1 ||
    submitted[0]?.sequence !== 0
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Confirm one current-location period for a growing or finished planting.",
    );
  }
  const period = submitted[0];
  if (!period) return;
  const latestMove = await unwrapDb(tx).query.gardenEntry.findFirst({
    where: and(
      eq(gardenEntry.plantingId, plantingId),
      eq(gardenEntry.kind, "move"),
      notDeleted(gardenEntry),
    ),
    columns: { observedOn: true },
    orderBy: [desc(gardenEntry.observedOn), desc(gardenEntry.createdAt)],
  });
  if (latestMove && period.inLocationSince < latestMove.observedOn) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The confirmed current location cannot begin before its latest recorded move.",
    );
  }
  await tx.insert(plantingLocationPeriod).values({
    plantingId,
    locationId: plantingState.locationId,
    sequence: 0,
    inLocationSince: period.inLocationSince,
    endedOn: period.endedOn ?? null,
    startKind: "actual",
    sourceGardenEntryId: null,
  });
};

export const correctLocationDates = async (
  db: Database,
  input: z.infer<typeof gardenCorrectLocationDatesInput>,
  actor?: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const plantingId = await required(tx, input.plantingId, "planting");
    const plantingState = await plantingRow(tx, plantingId);
    const existing = await unwrapDb(tx).query.plantingLocationPeriod.findMany({
      where: eq(plantingLocationPeriod.plantingId, plantingId),
      columns: {
        id: true,
        sequence: true,
        inLocationSince: true,
        endedOn: true,
        startKind: true,
        sourceGardenEntryId: true,
      },
      orderBy: [asc(plantingLocationPeriod.sequence)],
    });
    assertLocationPeriodDates(plantingState.status, input.periods);
    if (existing.length === 0) {
      await bootstrapConfirmedLocationPeriod(
        tx,
        plantingId,
        plantingState,
        input.periods,
      );
    } else {
      assertLocationCorrectionMatches(existing, input.periods);
      await applyLocationPeriodCorrections(tx, existing, input.periods);
    }
    const finalPeriod = input.periods.at(-1);
    if (
      plantingState.status === "finished" &&
      finalPeriod?.endedOn &&
      plantingState.finishedOn !== finalPeriod.endedOn
    ) {
      await tx
        .update(planting)
        .set({ finishedOn: finalPeriod.endedOn })
        .where(eq(planting.id, plantingId));
    }
    await auditGardenChange(tx, actor, "planting", plantingId, "update");
    return mapLocationHistory(tx, plantingId);
  });

export const gardenOptions = async (db: Database) => {
  const optionLocation = alias(location, "GardenOptionLocation");
  const [locations, ingredients, products, plantings] = await Promise.all([
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
    unwrapDb(db)
      .select({
        shortcode: planting.shortcode,
        status: planting.status,
        variety: planting.variety,
        ingredientName: ingredient.name,
        locationShortcode: optionLocation.shortcode,
        locationName: optionLocation.name,
      })
      .from(planting)
      .innerJoin(ingredient, eq(planting.ingredientId, ingredient.id))
      .leftJoin(optionLocation, eq(planting.locationId, optionLocation.id))
      .where(notDeleted(planting))
      .orderBy(asc(ingredient.name), asc(planting.createdAt)),
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
    plantings: plantings.map((row) => ({
      id: parseShortcodeFor("planting", row.shortcode),
      name: row.variety
        ? `${row.ingredientName} (${row.variety})`
        : row.ingredientName,
      locationId: row.locationShortcode
        ? parseShortcodeFor("location", row.locationShortcode)
        : null,
      locationName: row.locationName,
      status: row.status,
    })),
  });
};

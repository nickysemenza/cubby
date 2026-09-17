import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type GardenEntryFilters,
  gardenEntryOut,
  type gardenEntryCreateInput,
  type gardenEntryUpdateData,
} from "@cubby/schemas/garden-entry";
import {
  parseEntityId,
  parseShortcodeFor,
  type GardenEntryId,
  type PlantingId,
} from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import {
  type PlantingFilters,
  plantingOut,
  type plantingCreateInput,
  type plantingUpdateData,
} from "@cubby/schemas/planting";
import { and, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { gardenEntry, planting } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  guideWindowsFor,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  associatePendingImages,
  buildPartialUpdateValues,
  countWhere,
  eqAnyRequested,
  executeListQueryWithCount,
  imageJoinBindings,
  mapImages,
  type MappableImageRecord,
  notDeleted,
  syncEntityImages,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { withDisplayImages } from "~/server/repo/entity-display-image";
import { listScaffold } from "~/server/repo/list-scaffold";
import {
  resolveAllOrThrow,
  resolveFilterIds,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

type GardenDb = Database | DrizzleTransaction;

// `z.input`, not `z.infer`/`z.output`: every defaultable create field
// (`status`, `variety`, …) is optional pre-parse and non-optional
// post-parse, but this repo function does its own `?? null` coalescing
// rather than relying on zod's default-fill — the wider input type is both
// what a direct (non-entity-kernel) caller naturally writes and a safe
// supertype of what the entity kernel actually hands in (already-parsed
// output is assignable to the more permissive input shape).
type PlantingCreateInput = z.input<typeof plantingCreateInput>;
type PlantingUpdateData = z.infer<typeof plantingUpdateData>;
type GardenEntryCreateInput = z.input<typeof gardenEntryCreateInput>;
type GardenEntryUpdateData = z.infer<typeof gardenEntryUpdateData>;

/** Shared dashboard/list predicate; garden records are always soft-delete scoped. */
export const buildPlantingWhere = () => notDeleted(planting);

/** Shared dashboard/list predicate; garden entries are always soft-delete scoped. */
export const buildGardenEntryWhere = () => notDeleted(gardenEntry);

const required = async <
  T extends "ingredient" | "location" | "planting" | "product" | "task",
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

// The joins `plantingOut`'s name/guide projections read; shared by the row
// read and the list so both parse the same shape.
const plantingReferences = {
  ingredient: {
    columns: { shortcode: true, name: true, gardenGuideKey: true },
  },
  sourceProduct: { columns: { shortcode: true, name: true } },
  location: { columns: { shortcode: true, name: true } },
  task: { columns: { shortcode: true, name: true } },
} as const;

const plantingRow = async (db: GardenDb, id: PlantingId) => {
  const row = await unwrapDb(db).query.planting.findFirst({
    where: and(eq(planting.id, id), notDeleted(planting)),
    with: plantingReferences,
  });
  if (!row)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The planting no longer exists.",
    );
  return row;
};

type PlantingWithReferences = Awaited<ReturnType<typeof plantingRow>>;

const mapPlanting = (row: PlantingWithReferences) => {
  const gardenGuideKey = resolveGardenGuideKey(row.ingredient.gardenGuideKey);
  const { sow, transplant } = guideWindowsFor(gardenGuideKey);
  return plantingOut.parse({
    ...row,
    id: parseShortcodeFor("planting", row.shortcode),
    ingredientId: parseShortcodeFor("ingredient", row.ingredient.shortcode),
    sourceProductId: row.sourceProduct
      ? parseShortcodeFor("product", row.sourceProduct.shortcode)
      : null,
    locationId: row.location
      ? parseShortcodeFor("location", row.location.shortcode)
      : null,
    taskId: row.task ? parseShortcodeFor("task", row.task.shortcode) : null,
    ingredientName: row.ingredient.name,
    sourceProductName: row.sourceProduct?.name ?? null,
    locationName: row.location?.name ?? null,
    taskName: row.task?.name ?? null,
    guideSowWindow: sow,
    guideTransplantWindow: transplant,
    displayName: plantingDisplayName({
      ingredientName: row.ingredient.name,
      variety: row.variety,
    }),
  });
};

type GardenEntryWithReferences = typeof gardenEntry.$inferSelect & {
  location: { shortcode: string; name: string };
  planting: {
    shortcode: string;
    variety: string | null;
    ingredient: { name: string };
  } | null;
  images: Array<{ image: MappableImageRecord; deletedAt?: Date | null }>;
};

/** `"<ingredient name>[ · <variety>]"` — the canonical planting identity, shared
 * by `planting.displayName`, `gardenEntry.plantingName`, and the calendar's
 * planting item title (`repo/calendar-plantings.ts`). */
export const plantingDisplayName = (row: {
  ingredientName: string;
  variety: string | null;
}) =>
  row.variety ? `${row.ingredientName} · ${row.variety}` : row.ingredientName;

const GARDEN_ENTRY_KIND_LABELS = {
  note: "Note",
  harvest: "Harvest",
} satisfies Record<string, string>;

function isGardenEntryKindLabel(
  kind: string,
): kind is keyof typeof GARDEN_ENTRY_KIND_LABELS {
  return kind in GARDEN_ENTRY_KIND_LABELS;
}

/** `"<Kind> · <YYYY-MM-DD> · <location name>"` — gardenEntry has no name
 * column, so this is the canonical non-null identity for every surface. */
const gardenEntryDisplayName = (row: {
  kind: GardenEntryWithReferences["kind"];
  observedOn: string;
  locationName: string;
}) => {
  const kindLabel = isGardenEntryKindLabel(row.kind)
    ? GARDEN_ENTRY_KIND_LABELS[row.kind]
    : row.kind;
  return `${kindLabel} · ${row.observedOn} · ${row.locationName}`;
};

const mapEntry = (row: GardenEntryWithReferences) =>
  gardenEntryOut.parse({
    ...row,
    id: parseShortcodeFor("gardenEntry", row.shortcode),
    locationId: parseShortcodeFor("location", row.location.shortcode),
    plantingId: row.planting
      ? parseShortcodeFor("planting", row.planting.shortcode)
      : null,
    locationName: row.location.name,
    plantingName: row.planting
      ? plantingDisplayName({
          ingredientName: row.planting.ingredient.name,
          variety: row.planting.variety,
        })
      : null,
    displayName: gardenEntryDisplayName({
      kind: row.kind,
      observedOn: row.observedOn,
      locationName: row.location.name,
    }),
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

export const createPlanting = async (
  db: Database,
  data: PlantingCreateInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const ingredientId = await required(tx, data.ingredientId, "ingredient");
    const sourceProductId = data.sourceProductId
      ? await required(tx, data.sourceProductId, "product")
      : null;
    const locationId = data.locationId
      ? await required(tx, data.locationId, "location")
      : null;
    const taskId = data.taskId ? await required(tx, data.taskId, "task") : null;
    const row = await insertWithShortcode(tx, "planting", {
      ingredientId,
      sourceProductId,
      locationId,
      taskId,
      status: data.status ?? "planned",
      variety: data.variety ?? null,
      quantity: data.quantity ?? null,
      notes: data.notes ?? null,
      plannedWindow: data.plannedWindow ?? null,
      sowedOn: data.sowedOn ?? null,
      transplantedOn: data.transplantedOn ?? null,
      finishedOn: data.finishedOn ?? null,
    });
    await logAuditEntry(tx, actor, {
      entityType: "planting",
      entityId: row.id,
      action: "create",
    });
    return getPlanting(tx, parseEntityId("planting", row.id));
  });

export const createGardenEntry = async (
  db: Database,
  data: GardenEntryCreateInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const locationId = await required(tx, data.locationId, "location");
    const plantingId = data.plantingId
      ? await required(tx, data.plantingId, "planting")
      : null;
    const row = await insertWithShortcode(tx, "gardenEntry", {
      locationId,
      plantingId,
      kind: data.kind ?? "note",
      observedOn: data.observedOn,
      note: data.note ?? null,
      harvestAmount: data.harvestAmount ?? null,
    });
    if (data.pendingImageIds && data.pendingImageIds.length > 0) {
      // `resolveAllOrThrow`, not `resolveAllPresent`: unlike product/location/
      // recipe/purchase, a caller-supplied `IMG-` code that doesn't resolve
      // here is bad input, not a silent drop.
      const imageIds = await resolveAllOrThrow(
        tx,
        "image",
        data.pendingImageIds,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.gardenEntry,
        row.id,
        imageIds,
      );
    }
    await logAuditEntry(tx, actor, {
      entityType: "gardenEntry",
      entityId: row.id,
      action: "create",
    });
    return getGardenEntry(tx, parseEntityId("gardenEntry", row.id));
  });

/** Every field in the update roster is an ordinary patchable field — no
 * lifecycle guard. `status`/`locationId`/`finishedOn` change like any other
 * column, and the diff on the `model.audit` fields becomes the audit entry
 * `changes`, so the timeline shows what actually moved (not a bare "updated"). */
export const updatePlanting = async (
  db: Database,
  id: PlantingId,
  data: PlantingUpdateData,
  actor: ActorContext,
) => {
  const result = await withTransaction(db, async (tx) => {
    const before = await unwrapDb(tx).query.planting.findFirst({
      where: and(eq(planting.id, id), notDeleted(planting)),
    });
    if (!before) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The planting no longer exists.",
      );
    }
    const ingredientId =
      data.ingredientId !== undefined
        ? await required(tx, data.ingredientId, "ingredient")
        : undefined;
    const sourceProductId =
      data.sourceProductId !== undefined
        ? data.sourceProductId
          ? await required(tx, data.sourceProductId, "product")
          : null
        : undefined;
    const locationId =
      data.locationId !== undefined
        ? data.locationId
          ? await required(tx, data.locationId, "location")
          : null
        : undefined;
    const taskId =
      data.taskId !== undefined
        ? data.taskId
          ? await required(tx, data.taskId, "task")
          : null
        : undefined;
    const values = buildPartialUpdateValues({
      ingredientId,
      sourceProductId,
      locationId,
      taskId,
      status: data.status,
      variety: data.variety,
      quantity: data.quantity,
      notes: data.notes,
      plannedWindow: data.plannedWindow,
      sowedOn: data.sowedOn,
      transplantedOn: data.transplantedOn,
      finishedOn: data.finishedOn,
    });
    const updated = await updateLiveAndReturn(tx, planting, values, id);
    const changes = computeChanges(before, updated, [
      ...entityFieldModels.planting.audit,
    ]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "planting",
        entityId: id,
        action: "update",
        changes,
      });
    }
    return getPlanting(tx, id);
  });
  // No own images to sync (journal entries carry the photos); the entity
  // kernel's update shape still expects `detachedImageKeys`.
  const detachedImageKeys: string[] = [];
  return { planting: result, detachedImageKeys };
};

type GardenEntryUpdateInput = GardenEntryUpdateData & {
  pendingImageIds?: readonly string[];
  removeImageIds?: readonly string[];
  imageOrder?: readonly string[];
};

/** Every field in the update roster is an ordinary patchable field. */
export const updateGardenEntry = async (
  db: Database,
  id: GardenEntryId,
  data: GardenEntryUpdateInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const before = await unwrapDb(tx).query.gardenEntry.findFirst({
      where: and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
    });
    if (!before) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "The garden entry no longer exists.",
      );
    }
    const locationId =
      data.locationId !== undefined
        ? await required(tx, data.locationId, "location")
        : undefined;
    const plantingId =
      data.plantingId !== undefined
        ? data.plantingId
          ? await required(tx, data.plantingId, "planting")
          : null
        : undefined;
    const values = buildPartialUpdateValues({
      locationId,
      plantingId,
      kind: data.kind,
      observedOn: data.observedOn,
      note: data.note,
      harvestAmount: data.harvestAmount,
    });
    const updated = await updateLiveAndReturn(tx, gardenEntry, values, id);
    // `unresolved: "throw"` — a caller-supplied `IMG-` code that doesn't
    // resolve is bad input here, unlike product/location/recipe/purchase's
    // silent-drop convention.
    await syncEntityImages(
      tx,
      "gardenEntry",
      imageJoinBindings.gardenEntry,
      id,
      data,
      { unresolved: "throw" },
    );
    const changes = computeChanges(before, updated, [
      ...entityFieldModels.gardenEntry.audit,
    ]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "gardenEntry",
        entityId: id,
        action: "update",
        changes,
      });
    }
    return getGardenEntry(tx, id);
  });

const plantingScaffold = listScaffold("planting", planting);

export const plantingList = async (
  db: Database,
  filters: PlantingFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  // Id filters resolve shortcodes first; a requested set that resolves to
  // nothing matches nothing (`eqAnyRequested`), never the whole list.
  const [locationIds, ingredientIds, taskIds, sourceProductIds] =
    await Promise.all([
      resolveFilterIds(db, "location", filters.locationId),
      resolveFilterIds(db, "ingredient", filters.ingredientId),
      resolveFilterIds(db, "task", filters.taskId),
      resolveFilterIds(db, "product", filters.sourceProductId),
    ]);
  const where = plantingScaffold.where(filters, [
    buildPlantingWhere(),
    eqAnyRequested(planting.locationId, locationIds),
    eqAnyRequested(planting.ingredientId, ingredientIds),
    eqAnyRequested(planting.taskId, taskIds),
    eqAnyRequested(planting.sourceProductId, sourceProductIds),
  ]);
  const orderByArray = plantingScaffold.orderBy(sorts, undefined, filters);
  const { take, skip } = plantingScaffold.page(pagination);
  const { data: rows, count } = await executeListQueryWithCount({
    kind: "page",
    rows: () =>
      unwrapDb(db).query.planting.findMany({
        where,
        with: plantingReferences,
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

/**
 * A planting's journal always includes its direct entries. A whole-area
 * entry (no `plantingId`) joins too when it was observed at the planting's
 * current location within the planting's own active window — the planting
 * row itself is the history now (no separate confirmed-period table). The
 * window is read once and inlined: a correlated subquery would have to name
 * the outer table, which the relational query aliases differently from the
 * plain count query that runs beside it.
 */
const journalPredicate = async (db: Database, plantingId: PlantingId) => {
  const row = await unwrapDb(db).query.planting.findFirst({
    where: and(eq(planting.id, plantingId), notDeleted(planting)),
    columns: {
      locationId: true,
      sowedOn: true,
      transplantedOn: true,
      createdAt: true,
      finishedOn: true,
    },
  });
  const direct = eq(gardenEntry.plantingId, plantingId);
  if (!row || row.locationId === null) return direct;
  const start =
    row.sowedOn ??
    row.transplantedOn ??
    row.createdAt.toISOString().slice(0, 10);
  const wholeArea = [
    isNull(gardenEntry.plantingId),
    eq(gardenEntry.locationId, row.locationId),
    gte(gardenEntry.observedOn, start),
    row.finishedOn === null
      ? undefined
      : lte(gardenEntry.observedOn, row.finishedOn),
  ];
  return or(direct, and(...wholeArea));
};

export const gardenEntryList = async (
  db: Database,
  filters: GardenEntryFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  const [locationIds, plantingIds, journalPlantingId] = await Promise.all([
    resolveFilterIds(db, "location", filters.locationId),
    resolveFilterIds(db, "planting", filters.plantingId),
    filters.journalPlantingId === undefined
      ? undefined
      : resolveLiveShortcode(db, filters.journalPlantingId, "planting"),
  ]);
  const where = gardenEntryScaffold.where(filters, [
    buildGardenEntryWhere(),
    eqAnyRequested(gardenEntry.locationId, locationIds),
    eqAnyRequested(gardenEntry.plantingId, plantingIds),
    filters.journalPlantingId === undefined
      ? undefined
      : journalPlantingId
        ? await journalPredicate(
            db,
            parseEntityId("planting", journalPlantingId),
          )
        : sql`false`,
  ]);
  // `createdAt desc` is a deliberate stable tiebreak (was hard-coded as a
  // second `orderBy` entry alongside whichever field the caller picked) — a
  // `tieBreaker`, not a `resolve` special-case, so it can't swallow a second
  // user-requested sort (see `buildOrderBy`'s doc comment).
  const orderByArray = gardenEntryScaffold.orderBy(
    sorts,
    {
      tieBreaker: desc(gardenEntry.createdAt),
    },
    filters,
  );
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

import type { ActorContext } from "@cubby/schemas/context";
import type { DataQuality } from "@cubby/schemas/data-quality";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type GardenEntryFilters,
  gardenEntryOut,
  gardenEntryListItemOut,
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
  plantingListItemOut,
  type plantingCreateInput,
  type plantingUpdateData,
} from "@cubby/schemas/planting";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import { householdLocalDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityLink,
  gardenEntry,
  plant,
  planting,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  expectedHarvestFor,
  guideWindowsFor,
  plantingDisplayName,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import {
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality/hydrate";
import {
  associatePendingImages,
  buildPartialUpdateValues,
  eqAnyRequested,
  householdDaySql,
  imageJoinBindings,
  mapImages,
  type MappableImageRecord,
  notDeleted,
  shortcodeSetCondition,
  syncEntityImages,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { linkValues, liveLinks, ofLinkKind } from "~/server/repo/entity-links";
import { listScaffold } from "~/server/repo/list";
import {
  hydrateListRead,
  loadListGroup,
  type ListProjection,
  wantsListGroup,
} from "~/server/repo/list-projection";
import { getCategoryFeature } from "~/server/repo/product-category";
import {
  resolveAllOrThrow,
  resolveFilterIds,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { parseCompleteListRead } from "../list-read-adapters";

type GardenDb = Database | DrizzleTransaction;

// `z.input`, not `z.infer`/`z.output`: every defaultable create field
// (`status`, `outcome`, …) is optional pre-parse and non-optional
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
  T extends "location" | "plant" | "planting" | "product" | "task",
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

/** Keep garden source links semantic without introducing a Product subtype. */
const validatePlantingSource = async (
  db: GardenDb,
  plantId: string | null,
  sourceProductId: string | null,
): Promise<void> => {
  if (!sourceProductId) return;
  const source = await unwrapDb(db).query.product.findFirst({
    where: and(
      eq(product.id, parseEntityId("product", sourceProductId)),
      notDeleted(product),
    ),
    columns: { categoryId: true, growsPlantId: true },
  });
  if (!source) return;
  if ((await getCategoryFeature(db, source.categoryId)) === "food") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting source Product must be a garden product, not a food Product.",
    );
  }
  if (source.growsPlantId && plantId && source.growsPlantId !== plantId) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The planting source Product grows a different plant.",
    );
  }
};

// The joins `plantingOut`'s name/guide projections read; shared by the row
// read and the list so both parse the same shape.
const plantingReferences = {
  plant: {
    columns: {
      shortcode: true,
      name: true,
      gardenGuideKey: true,
      daysFromSowMin: true,
      daysFromSowMax: true,
      daysFromTransplantMin: true,
      daysFromTransplantMax: true,
    },
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

type PlantingReadRow = typeof planting.$inferSelect & {
  plant:
    | (Pick<
        NonNullable<PlantingWithReferences["plant"]>,
        "name" | "gardenGuideKey"
      > &
        Partial<NonNullable<PlantingWithReferences["plant"]>>)
    | null;
  sourceProduct?: PlantingWithReferences["sourceProduct"];
  location?: PlantingWithReferences["location"];
  task?: PlantingWithReferences["task"];
};

const plantingRelationFields = (row: PlantingReadRow) => ({
  plantId: row.plant?.shortcode
    ? parseShortcodeFor("plant", row.plant.shortcode)
    : null,
  sourceProductId: row.sourceProduct
    ? parseShortcodeFor("product", row.sourceProduct.shortcode)
    : null,
  locationId: row.location
    ? parseShortcodeFor("location", row.location.shortcode)
    : null,
  taskId: row.task ? parseShortcodeFor("task", row.task.shortcode) : null,
  plantName: row.plant?.name ?? null,
  sourceProductName: row.sourceProduct?.name ?? null,
  locationName: row.location?.name ?? null,
  taskName: row.task?.name ?? null,
});

const plantingDerivedFields = (row: PlantingReadRow) => {
  const gardenGuideKey = resolveGardenGuideKey(row.plant?.gardenGuideKey);
  const { sow, transplant } = guideWindowsFor(gardenGuideKey);
  const harvest = expectedHarvestFor({
    key: gardenGuideKey,
    plant: row.plant
      ? {
          daysFromSowMin: row.plant.daysFromSowMin ?? null,
          daysFromSowMax: row.plant.daysFromSowMax ?? null,
          daysFromTransplantMin: row.plant.daysFromTransplantMin ?? null,
          daysFromTransplantMax: row.plant.daysFromTransplantMax ?? null,
        }
      : null,
    sowedOn: row.sowedOn,
    transplantedOn: row.transplantedOn,
  });
  return {
    guideSowWindow: sow,
    guideTransplantWindow: transplant,
    expectedHarvestStart: harvest?.start ?? null,
    expectedHarvestEnd: harvest?.end ?? null,
    expectedHarvest: harvest?.summary ?? null,
  };
};

const mapPlantingRead = (
  row: PlantingReadRow,
  projection: ListProjection,
  dataQuality?: DataQuality,
) => {
  const result = {
    ...row,
    id: parseShortcodeFor("planting", row.shortcode),
    displayName: plantingDisplayName(row.plant),
  };
  if (wantsListGroup(projection, "relations"))
    Object.assign(result, plantingRelationFields(row));
  if (wantsListGroup(projection, "derived"))
    Object.assign(result, plantingDerivedFields(row));
  if (dataQuality) Object.assign(result, { dataQuality });
  return result;
};

const mapPlanting = (row: PlantingWithReferences, dataQuality: DataQuality) =>
  plantingOut.parse(mapPlantingRead(row, { kind: "full" }, dataQuality));

type GardenEntryWithReferences = typeof gardenEntry.$inferSelect & {
  location: { shortcode: string; name: string };
  plantings: Array<{
    planting: {
      shortcode: string;
      plant: { name: string; gardenGuideKey: string | null } | null;
    } | null;
  }>;
  images: Array<{ image: MappableImageRecord; deletedAt?: Date | null }>;
};

export { plantingDisplayName } from "~/server/garden-guides/windows";

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

type GardenEntryReadRow = Omit<
  GardenEntryWithReferences,
  "plantings" | "images"
> &
  Partial<Pick<GardenEntryWithReferences, "plantings" | "images">>;

const mapEntryRead = (
  row: GardenEntryReadRow,
  projection: ListProjection,
  dataQuality?: DataQuality,
) => {
  const result = {
    ...row,
    id: parseShortcodeFor("gardenEntry", row.shortcode),
    displayName: gardenEntryDisplayName({
      kind: row.kind,
      observedOn: row.observedOn,
      locationName: row.location.name,
    }),
  };
  if (wantsListGroup(projection, "relations")) {
    const plantings = (row.plantings ?? [])
      .flatMap((link) => (link.planting ? [link.planting] : []))
      .sort((left, right) => left.shortcode.localeCompare(right.shortcode));
    Object.assign(result, {
      locationId: parseShortcodeFor("location", row.location.shortcode),
      locationName: row.location.name,
      plantingIds: plantings.map((linked) =>
        parseShortcodeFor("planting", linked.shortcode),
      ),
      plantings: plantings.map((linked) => ({
        id: parseShortcodeFor("planting", linked.shortcode),
        name: plantingDisplayName(linked.plant),
      })),
    });
  }
  if (wantsListGroup(projection, "media"))
    Object.assign(result, { images: mapImages(row.images ?? []) });
  if (dataQuality) Object.assign(result, { dataQuality });
  return result;
};

const mapEntry = (row: GardenEntryWithReferences, dataQuality: DataQuality) =>
  gardenEntryOut.parse(mapEntryRead(row, { kind: "full" }, dataQuality));

export const getPlanting = async (db: GardenDb, id: PlantingId) => {
  const row = await plantingRow(db, id);
  const dataQualities = await loadDataQualities(db, "planting", [id]);
  // SAFETY: `row` was just fetched live by `id`, so its quality was evaluated.
  return mapPlanting(row, dataQualities.get(id)!);
};

/**
 * Each entry's live planting links, in the shape `mapEntry` reads. The
 * planting itself is not filtered by liveness: a link to a removed planting
 * still names it, as the relation read it before links moved to EntityLink.
 */
const loadEntryPlantings = async (
  db: GardenDb,
  entryIds: readonly string[],
): Promise<Map<string, GardenEntryWithReferences["plantings"]>> => {
  const out = new Map<string, GardenEntryWithReferences["plantings"]>();
  if (entryIds.length === 0) return out;
  const rows = await unwrapDb(db)
    .select({
      entryId: entityLink.fromEntityId,
      shortcode: planting.shortcode,
      plantName: plant.name,
      gardenGuideKey: plant.gardenGuideKey,
    })
    .from(entityLink)
    .innerJoin(planting, eq(planting.id, entityLink.toEntityId))
    .leftJoin(plant, eq(plant.id, planting.plantId))
    .where(
      and(
        liveLinks("gardenEntryPlanting"),
        inArray(entityLink.fromEntityId, [...entryIds]),
      ),
    );
  for (const row of rows) {
    out.set(row.entryId, [
      ...(out.get(row.entryId) ?? []),
      {
        planting: {
          shortcode: row.shortcode,
          plant:
            row.plantName === null
              ? null
              : { name: row.plantName, gardenGuideKey: row.gardenGuideKey },
        },
      },
    ]);
  }
  return out;
};

export const getGardenEntry = async (db: GardenDb, id: GardenEntryId) => {
  const row = await unwrapDb(db).query.gardenEntry.findFirst({
    where: and(eq(gardenEntry.id, id), notDeleted(gardenEntry)),
    with: {
      location: { columns: { shortcode: true, name: true } },
      images: { with: { image: true } },
    },
  });
  if (!row)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The garden entry no longer exists.",
    );
  const [dataQualities, plantingsByEntry] = await Promise.all([
    loadDataQualities(db, "gardenEntry", [id]),
    loadEntryPlantings(db, [id]),
  ]);
  // SAFETY: `row` was just fetched live by `id`, so its quality was evaluated.
  return mapEntry(
    { ...row, plantings: plantingsByEntry.get(id) ?? [] },
    dataQualities.get(id)!,
  );
};

/**
 * Replace one entry's live planting set while retaining association history.
 * The caller owns the surrounding transaction.  Existing tombstones are
 * rematerialized instead of creating a second row for the same pair.
 */
const replaceGardenEntryPlantings = async (
  tx: DrizzleTransaction,
  gardenEntryId: GardenEntryId,
  plantingShortcodes: readonly string[],
): Promise<string[]> => {
  // Serialize replacements for one entry.  The live-pair partial unique index
  // protects duplicates, but only the parent row lock makes two concurrent
  // full-set replacements observe and audit one deterministic predecessor.
  await tx
    .select({ id: gardenEntry.id })
    .from(gardenEntry)
    .where(and(eq(gardenEntry.id, gardenEntryId), notDeleted(gardenEntry)))
    .for("update");
  const resolved = await resolveAllOrThrow(tx, "planting", plantingShortcodes);
  const nextIds = [...new Set(resolved)];
  const rows = await unwrapDb(tx)
    .select({
      id: entityLink.id,
      plantingId: entityLink.toEntityId,
      deletedAt: entityLink.deletedAt,
      createdAt: entityLink.createdAt,
    })
    .from(entityLink)
    .where(
      and(
        ofLinkKind("gardenEntryPlanting"),
        eq(entityLink.fromEntityId, gardenEntryId),
      ),
    )
    .orderBy(desc(entityLink.createdAt));
  const liveRows = rows.filter((row) => row.deletedAt === null);
  const currentIds = new Set(liveRows.map((row) => row.plantingId));
  const nextIdSet = new Set<string>(nextIds);
  const now = new Date();

  const removedIds = liveRows
    .map((row) => row.plantingId)
    .filter((id) => !nextIdSet.has(id));
  if (removedIds.length > 0) {
    await tx
      .update(entityLink)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(entityLink.fromEntityId, gardenEntryId),
          inArray(entityLink.toEntityId, removedIds),
          liveLinks("gardenEntryPlanting"),
        ),
      );
  }

  const addIds = nextIds.filter((id) => !currentIds.has(id));
  for (const plantingId of addIds) {
    const tombstone = rows.find(
      (row) => row.plantingId === plantingId && row.deletedAt !== null,
    );
    if (tombstone) {
      await tx
        .update(entityLink)
        .set({ deletedAt: null, updatedAt: now })
        .where(eq(entityLink.id, tombstone.id));
    } else {
      await tx
        .insert(entityLink)
        .values(linkValues("gardenEntryPlanting", gardenEntryId, plantingId));
    }
  }

  const shortcodeRows = await unwrapDb(tx)
    .select({ shortcode: planting.shortcode })
    .from(planting)
    .innerJoin(
      entityLink,
      and(
        eq(entityLink.toEntityId, planting.id),
        eq(entityLink.fromEntityId, gardenEntryId),
        liveLinks("gardenEntryPlanting"),
      ),
    )
    .where(notDeleted(planting))
    .orderBy(planting.shortcode);
  return shortcodeRows.map((row) =>
    parseShortcodeFor("planting", row.shortcode),
  );
};

export const createPlanting = async (
  db: Database,
  data: PlantingCreateInput,
  actor: ActorContext,
) =>
  withTransaction(db, async (tx) => {
    const plantId = await required(tx, data.plantId, "plant");
    const sourceProductId = data.sourceProductId
      ? await required(tx, data.sourceProductId, "product")
      : null;
    await validatePlantingSource(tx, plantId, sourceProductId);
    const locationId = data.locationId
      ? await required(tx, data.locationId, "location")
      : null;
    const taskId = data.taskId ? await required(tx, data.taskId, "task") : null;
    const row = await insertWithShortcode(tx, "planting", {
      plantId,
      sourceProductId,
      locationId,
      taskId,
      status: data.status ?? "planned",
      outcome: data.outcome ?? null,
      quantity: data.quantity ?? null,
      notes: data.notes ?? null,
      plannedWindow: data.plannedWindow ?? null,
      sowedOn: data.sowedOn ?? null,
      transplantedOn: data.transplantedOn ?? null,
      finishedOn: data.finishedOn ?? null,
    });
    await logAuditEntry(tx, actor, {
      entityKind: "planting",
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
    const row = await insertWithShortcode(tx, "gardenEntry", {
      locationId,
      kind: data.kind ?? "note",
      observedOn: data.observedOn,
      notes: data.notes ?? null,
      harvestAmount: data.harvestAmount ?? null,
    });
    if (data.plantingIds !== undefined) {
      await replaceGardenEntryPlantings(
        tx,
        parseEntityId("gardenEntry", row.id),
        data.plantingIds,
      );
    }
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
      entityKind: "gardenEntry",
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
    const plantId =
      data.plantId !== undefined
        ? await required(tx, data.plantId, "plant")
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
    await validatePlantingSource(
      tx,
      plantId === undefined ? before.plantId : plantId,
      sourceProductId === undefined ? before.sourceProductId : sourceProductId,
    );
    const values = buildPartialUpdateValues({
      plantId,
      sourceProductId,
      locationId,
      taskId,
      status: data.status,
      outcome: data.outcome,
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
        entityKind: "planting",
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
    let beforePlantingIds: string[] | undefined;
    let plantingIdsChanged = false;
    if (data.plantingIds !== undefined) {
      const beforeRows = await unwrapDb(tx)
        .select({ shortcode: planting.shortcode })
        .from(entityLink)
        .innerJoin(planting, eq(planting.id, entityLink.toEntityId))
        .where(
          and(
            eq(entityLink.fromEntityId, id),
            liveLinks("gardenEntryPlanting"),
            notDeleted(planting),
          ),
        )
        .orderBy(planting.shortcode);
      beforePlantingIds = beforeRows.map((row) =>
        parseShortcodeFor("planting", row.shortcode),
      );
      const resolved = await resolveAllOrThrow(
        tx,
        "planting",
        data.plantingIds,
      );
      const nextRows = await unwrapDb(tx)
        .select({ shortcode: planting.shortcode })
        .from(planting)
        .where(inArray(planting.id, [...new Set(resolved)]))
        .orderBy(planting.shortcode);
      const nextPlantingIds = nextRows.map((row) =>
        parseShortcodeFor("planting", row.shortcode),
      );
      plantingIdsChanged =
        diffUnorderedIdSet(beforePlantingIds, nextPlantingIds) !== undefined;
    }
    const values = buildPartialUpdateValues({
      locationId,
      kind: data.kind,
      observedOn: data.observedOn,
      notes: data.notes,
      harvestAmount: data.harvestAmount,
      // Association-only edits are still edits to the GardenEntry resource;
      // keep its optimistic/concurrency timestamp monotonic even when all
      // scalar fields were omitted.
      updatedAt: plantingIdsChanged ? new Date() : undefined,
    });
    const updated = await updateLiveAndReturn(tx, gardenEntry, values, id);
    let afterPlantingIds: string[] | undefined;
    if (data.plantingIds !== undefined) {
      afterPlantingIds = await replaceGardenEntryPlantings(
        tx,
        id,
        data.plantingIds,
      );
    }
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
    const changes = computeChanges(
      before,
      updated,
      entityFieldModels.gardenEntry.audit.filter(
        (field) => field !== "plantingIds",
      ),
    );
    const plantingChanges =
      beforePlantingIds && afterPlantingIds
        ? diffUnorderedIdSet(beforePlantingIds, afterPlantingIds)
        : undefined;
    const allChanges = plantingChanges
      ? { ...changes, plantingIds: plantingChanges }
      : changes;
    if (allChanges) {
      await logAuditEntry(tx, actor, {
        entityKind: "gardenEntry",
        entityId: id,
        action: "update",
        changes: allChanges,
      });
    }
    return getGardenEntry(tx, id);
  });

const plantingScaffold = listScaffold("planting", planting);

export const plantingListRead = async (
  db: Database,
  filters: PlantingFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
  projection: ListProjection = { kind: "full" },
) => {
  // Id filters resolve shortcodes first; a requested set that resolves to
  // nothing matches nothing (`eqAnyRequested`), never the whole list.
  const [locationIds, plantIds, taskIds, sourceProductIds] = await Promise.all([
    resolveFilterIds(db, "location", filters.locationId),
    resolveFilterIds(db, "plant", filters.plantId),
    resolveFilterIds(db, "task", filters.taskId),
    resolveFilterIds(db, "product", filters.sourceProductId),
  ]);
  const where = plantingScaffold.where(filters, [
    buildPlantingWhere(),
    filters.activeOn
      ? sql`COALESCE(${planting.sowedOn}, ${planting.transplantedOn}, ${householdDaySql(planting.createdAt)}) <= ${filters.activeOn}::date
          AND (${planting.finishedOn} IS NULL OR ${planting.finishedOn} >= ${filters.activeOn}::date)`
      : undefined,
    eqAnyRequested(planting.locationId, locationIds),
    eqAnyRequested(planting.plantId, plantIds),
    eqAnyRequested(planting.taskId, taskIds),
    eqAnyRequested(planting.sourceProductId, sourceProductIds),
    filters.gardenEntryId === undefined
      ? undefined
      : sql`EXISTS (
          SELECT 1
          FROM "EntityLink" gep
          JOIN "GardenEntry" ge ON ge."id" = gep."fromEntityId" AND ge."deletedAt" IS NULL
          WHERE gep."toEntityId" = ${planting.id}
            AND gep."deletedAt" IS NULL AND gep."kind" = 'gardenEntryPlanting'
            AND ${shortcodeSetCondition(sql`ge."shortcode"`, filters.gardenEntryId)})`,
  ]);
  return plantingScaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where,
      select: (page, selected) =>
        unwrapDb(db).query.planting.findMany({
          ...page,
          with: {
            plant:
              wantsListGroup(selected, "derived") ||
              wantsListGroup(selected, "relations")
                ? plantingReferences.plant
                : { columns: { name: true, gardenGuideKey: true } },
            sourceProduct: wantsListGroup(selected, "relations")
              ? plantingReferences.sourceProduct
              : undefined,
            location: wantsListGroup(selected, "relations")
              ? plantingReferences.location
              : undefined,
            task: wantsListGroup(selected, "relations")
              ? plantingReferences.task
              : undefined,
          },
        }),
      hydrate: (rows, selected) =>
        hydrateListRead(db, "planting", rows, selected, {
          media: true,
          load: async () => undefined,
          mapRow: (row, { quality }) => mapPlantingRead(row, selected, quality),
        }),
    },
  );
};

export const plantingList = async (
  db: Database,
  filters: PlantingFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  const result = await plantingListRead(db, filters, pagination, sorts, {
    kind: "full",
  });
  return parseCompleteListRead(plantingListItemOut, Promise.resolve(result));
};

const gardenEntryScaffold = listScaffold("gardenEntry", gardenEntry);

/**
 * A planting's journal always includes its direct live associations. A
 * whole-area entry joins only when it has no live planting associations and
 * was observed at the planting's current location within the planting's own
 * active window. The window is read once and inlined: a correlated subquery
 * would have to name the outer table, which the relational query aliases
 * differently from the plain count query that runs beside it.
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
  const directEntryIds = unwrapDb(db)
    .select({ id: entityLink.fromEntityId })
    .from(entityLink)
    .where(
      and(
        eq(entityLink.toEntityId, plantingId),
        liveLinks("gardenEntryPlanting"),
      ),
    );
  if (!row || row.locationId === null) {
    return inArray(gardenEntry.id, directEntryIds);
  }

  // The relational list query aliases its outer GardenEntry table while the
  // count query does not. Build self-contained id subqueries rather than a
  // correlated predicate against that unstable outer alias.
  const wholeAreaEntry = alias(gardenEntry, "wholeAreaGardenEntry");
  const wholeAreaLink = alias(entityLink, "wholeAreaGardenEntryPlanting");
  const start =
    row.sowedOn ?? row.transplantedOn ?? householdLocalDate(row.createdAt);
  const wholeAreaEntryIds = unwrapDb(db)
    .select({ id: wholeAreaEntry.id })
    .from(wholeAreaEntry)
    .where(
      and(
        notExists(
          unwrapDb(db)
            .select({ id: wholeAreaLink.id })
            .from(wholeAreaLink)
            .where(
              and(
                eq(wholeAreaLink.fromEntityId, wholeAreaEntry.id),
                liveLinks("gardenEntryPlanting", wholeAreaLink),
              ),
            ),
        ),
        eq(wholeAreaEntry.locationId, row.locationId),
        gte(wholeAreaEntry.observedOn, start),
        row.finishedOn === null
          ? undefined
          : lte(wholeAreaEntry.observedOn, row.finishedOn),
      ),
    );
  return or(
    inArray(gardenEntry.id, directEntryIds),
    inArray(gardenEntry.id, wholeAreaEntryIds),
  );
};

export const gardenEntryListRead = async (
  db: Database,
  filters: GardenEntryFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
  projection: ListProjection = { kind: "full" },
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
    // Uncorrelated `IN` sub-select, not a correlated `EXISTS` — same alias
    // trap `journalPredicate` documents above: the relational list query
    // aliases its outer GardenEntry table while the count query does not.
    plantingIds && plantingIds.length > 0
      ? inArray(
          gardenEntry.id,
          unwrapDb(db)
            .select({ id: entityLink.fromEntityId })
            .from(entityLink)
            .where(
              and(
                inArray(entityLink.toEntityId, plantingIds),
                liveLinks("gardenEntryPlanting"),
              ),
            ),
        )
      : plantingIds
        ? sql`false`
        : undefined,
    filters.journalPlantingId === undefined
      ? undefined
      : journalPlantingId
        ? await journalPredicate(
            db,
            parseEntityId("planting", journalPlantingId),
          )
        : sql`false`,
  ]);
  return gardenEntryScaffold.list(
    db,
    { filters, sorts, pagination, projection },
    {
      where,
      // `createdAt desc` is a deliberate stable tiebreak — a `tieBreaker`, not
      // a `resolve` special-case, so it can't swallow a second user-requested
      // sort (see `buildOrderBy`'s doc comment).
      tieBreaker: desc(gardenEntry.createdAt),
      select: (page, selected) =>
        unwrapDb(db).query.gardenEntry.findMany({
          ...page,
          with: {
            location: { columns: { shortcode: true, name: true } },
            images: wantsListGroup(selected, "media")
              ? { with: { image: true } }
              : undefined,
          },
        }),
      hydrate: (rows, selected) =>
        hydrateListRead(db, "gardenEntry", rows, selected, {
          media: true,
          load: () =>
            loadListGroup(selected, "relations", () =>
              loadEntryPlantings(
                db,
                rows.map((row) => row.id),
              ),
            ),
          mapRow: (row, { loaded: plantingsByEntry, quality }) =>
            mapEntryRead(
              {
                ...row,
                plantings: plantingsByEntry?.get(row.id),
                images: (row.images ?? []).flatMap((entry) =>
                  "image" in entry ? [entry] : [],
                ),
              },
              selected,
              quality,
            ),
        }),
    },
  );
};

export const gardenEntryList = async (
  db: Database,
  filters: GardenEntryFilters,
  pagination: PaginationParams,
  sorts: SortParams[] = [],
) => {
  const result = await gardenEntryListRead(db, filters, pagination, sorts, {
    kind: "full",
  });
  return parseCompleteListRead(gardenEntryListItemOut, Promise.resolve(result));
};

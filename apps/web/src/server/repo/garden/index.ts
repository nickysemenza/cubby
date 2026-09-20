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
import {
  and,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  gardenEntry,
  gardenEntryPlanting,
  planting,
  product,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  guideWindowsFor,
  resolveGardenGuideKey,
} from "~/server/garden-guides/windows";
import {
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntry,
} from "~/server/repo/audit-log";
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

/** Keep garden source links semantic without introducing a Product subtype. */
const validatePlantingSource = async (
  db: GardenDb,
  ingredientId: string,
  sourceProductId: string | null,
): Promise<void> => {
  if (!sourceProductId) return;
  const source = await unwrapDb(db).query.product.findFirst({
    where: and(
      eq(product.id, parseEntityId("product", sourceProductId)),
      isNull(product.deletedAt),
    ),
    columns: { category: true, growsIngredientId: true },
  });
  if (!source) return;
  if (source.category === "food") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting source Product must be a garden product, not a food Product.",
    );
  }
  if (source.growsIngredientId && source.growsIngredientId !== ingredientId) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "The planting source Product grows a different crop.",
    );
  }
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
  plantings: Array<{
    planting: {
      shortcode: string;
      variety: string | null;
      ingredient: { name: string };
    } | null;
  }>;
  images: Array<{ image: MappableImageRecord; deletedAt?: Date | null }>;
};

/** `"<ingredient name>[ · <variety>]"` — the canonical planting identity, shared
 * by `planting.displayName`, garden-entry planting references, and the
 * calendar's planting item title (`repo/calendar-plantings.ts`). */
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
    ...(() => {
      const plantings = row.plantings
        .flatMap((link) => (link.planting ? [link.planting] : []))
        .sort((left, right) => left.shortcode.localeCompare(right.shortcode));
      return {
        plantingIds: plantings.map((linked) =>
          parseShortcodeFor("planting", linked.shortcode),
        ),
        plantings: plantings.map((linked) => ({
          id: parseShortcodeFor("planting", linked.shortcode),
          name: plantingDisplayName({
            ingredientName: linked.ingredient.name,
            variety: linked.variety,
          }),
        })),
      };
    })(),
    locationName: row.location.name,
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
      plantings: {
        where: notDeleted(gardenEntryPlanting),
        with: {
          planting: {
            columns: { shortcode: true, variety: true },
            with: { ingredient: { columns: { name: true } } },
          },
        },
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
      id: gardenEntryPlanting.id,
      plantingId: gardenEntryPlanting.plantingId,
      deletedAt: gardenEntryPlanting.deletedAt,
      createdAt: gardenEntryPlanting.createdAt,
    })
    .from(gardenEntryPlanting)
    .where(eq(gardenEntryPlanting.gardenEntryId, gardenEntryId))
    .orderBy(desc(gardenEntryPlanting.createdAt));
  const liveRows = rows.filter((row) => row.deletedAt === null);
  const currentIds = new Set(liveRows.map((row) => row.plantingId));
  const nextIdSet = new Set(nextIds);
  const now = new Date();

  const removedIds = liveRows
    .map((row) => row.plantingId)
    .filter((id) => !nextIdSet.has(id));
  if (removedIds.length > 0) {
    await tx
      .update(gardenEntryPlanting)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(gardenEntryPlanting.gardenEntryId, gardenEntryId),
          inArray(gardenEntryPlanting.plantingId, removedIds),
          notDeleted(gardenEntryPlanting),
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
        .update(gardenEntryPlanting)
        .set({ deletedAt: null, updatedAt: now })
        .where(eq(gardenEntryPlanting.id, tombstone.id));
    } else {
      await tx.insert(gardenEntryPlanting).values({
        gardenEntryId,
        plantingId,
      });
    }
  }

  const shortcodeRows = await unwrapDb(tx)
    .select({ shortcode: planting.shortcode })
    .from(planting)
    .innerJoin(
      gardenEntryPlanting,
      and(
        eq(gardenEntryPlanting.plantingId, planting.id),
        eq(gardenEntryPlanting.gardenEntryId, gardenEntryId),
        notDeleted(gardenEntryPlanting),
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
    const ingredientId = await required(tx, data.ingredientId, "ingredient");
    const sourceProductId = data.sourceProductId
      ? await required(tx, data.sourceProductId, "product")
      : null;
    await validatePlantingSource(tx, ingredientId, sourceProductId);
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
    const row = await insertWithShortcode(tx, "gardenEntry", {
      locationId,
      kind: data.kind ?? "note",
      observedOn: data.observedOn,
      note: data.note ?? null,
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
    await validatePlantingSource(
      tx,
      ingredientId ?? before.ingredientId,
      sourceProductId === undefined ? before.sourceProductId : sourceProductId,
    );
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
    let beforePlantingIds: string[] | undefined;
    let plantingIdsChanged = false;
    if (data.plantingIds !== undefined) {
      const beforeRows = await unwrapDb(tx)
        .select({ shortcode: planting.shortcode })
        .from(gardenEntryPlanting)
        .innerJoin(planting, eq(planting.id, gardenEntryPlanting.plantingId))
        .where(
          and(
            eq(gardenEntryPlanting.gardenEntryId, id),
            notDeleted(gardenEntryPlanting),
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
      note: data.note,
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
        entityType: "gardenEntry",
        entityId: id,
        action: "update",
        changes: allChanges,
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
    filters.activeOn
      ? sql`COALESCE(${planting.sowedOn}, ${planting.transplantedOn}, ${planting.createdAt}::date) <= ${filters.activeOn}::date
          AND (${planting.finishedOn} IS NULL OR ${planting.finishedOn} >= ${filters.activeOn}::date)`
      : undefined,
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
    .select({ id: gardenEntryPlanting.gardenEntryId })
    .from(gardenEntryPlanting)
    .where(
      and(
        eq(gardenEntryPlanting.plantingId, plantingId),
        notDeleted(gardenEntryPlanting),
      ),
    );
  if (!row || row.locationId === null) {
    return inArray(gardenEntry.id, directEntryIds);
  }

  // The relational list query aliases its outer GardenEntry table while the
  // count query does not. Build self-contained id subqueries rather than a
  // correlated predicate against that unstable outer alias.
  const wholeAreaEntry = alias(gardenEntry, "wholeAreaGardenEntry");
  const wholeAreaLink = alias(
    gardenEntryPlanting,
    "wholeAreaGardenEntryPlanting",
  );
  const start =
    row.sowedOn ??
    row.transplantedOn ??
    row.createdAt.toISOString().slice(0, 10);
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
                eq(wholeAreaLink.gardenEntryId, wholeAreaEntry.id),
                notDeleted(wholeAreaLink),
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
    plantingIds && plantingIds.length > 0
      ? exists(
          unwrapDb(db)
            .select({ id: gardenEntryPlanting.id })
            .from(gardenEntryPlanting)
            .where(
              and(
                eq(gardenEntryPlanting.gardenEntryId, gardenEntry.id),
                inArray(gardenEntryPlanting.plantingId, plantingIds),
                notDeleted(gardenEntryPlanting),
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
          plantings: {
            where: notDeleted(gardenEntryPlanting),
            with: {
              planting: {
                columns: { shortcode: true, variety: true },
                with: { ingredient: { columns: { name: true } } },
              },
            },
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

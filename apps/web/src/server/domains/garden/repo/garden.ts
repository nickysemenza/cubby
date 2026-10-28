import type { ActorContext } from "@cubby/schemas/context";
import { dateRangeFromDates } from "@cubby/schemas/date-range";
import {
  type gardenEntryCreateInput,
  type gardenEntryUpdateData,
} from "@cubby/schemas/entities/gardenEntry";
import {
  type plantingCreateInput,
  type plantingUpdateData,
} from "@cubby/schemas/entities/planting";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { EntityLinkKind } from "@cubby/schemas/entity-links";
import {
  rawGardenEntryOut,
  rawGardenEntryListItemOut,
  type RawGardenEntryOut,
} from "@cubby/schemas/garden-entry-raw-read";
import {
  parseEntityId,
  parseShortcodeFor,
  type GardenEntryId,
  type PlantingId,
} from "@cubby/schemas/identifiers";
import {
  rawPlantingOut,
  rawPlantingListItemOut,
  type RawPlantingOut,
} from "@cubby/schemas/planting-raw-read";
import { isPlantingSourceFeature } from "@cubby/schemas/product-category-relations";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  associatePendingImages,
  buildPartialUpdateValues,
  householdDaySql,
  galleryBinding,
  mapImages,
  type MappableImageRecord,
  notDeleted,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import {
  entityLink,
  gardenEntry,
  plant,
  planting,
  product,
} from "~/server/db/schema";
import { gardenEntrySearch } from "~/server/domains/garden/repo/search-read-garden-entry";
import { plantingSearch } from "~/server/domains/garden/repo/search-read-planting";
import { syncEntityImages } from "~/server/domains/image/repo/entity-image-sync";
import {
  expectedHarvestFor,
  guideWindowsFor,
  plantingDisplayName,
  resolveGardenGuideKey,
} from "~/server/domains/plant/repo/windows";
import { getCategoryFeature } from "~/server/domains/product-category/repo/product-category";
import {
  type MutationReceipt,
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import {
  assertLiveLinkEndpoints,
  linkValues,
  liveLinks,
  ofLinkKind,
} from "~/server/generic/entity-links/repo/entity-links";
import { listScaffold } from "~/server/generic/list/repo/list";
import {
  resolveAllOrThrow,
  resolveLiveShortcode,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

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
  if (
    !isPlantingSourceFeature(await getCategoryFeature(db, source.categoryId))
  ) {
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

// The joins `rawPlantingOut`'s name/guide projections read; shared by the row
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

const loadPlantingReferences = (db: GardenDb, ids: readonly string[]) =>
  unwrapDb(db).query.planting.findMany({
    where: inArray(
      planting.id,
      ids.map((id) => parseEntityId("planting", id)),
    ),
    columns: { id: true },
    with: plantingReferences,
  });

type PlantingWithReferences = Awaited<
  ReturnType<typeof loadPlantingReferences>
>[number];

type PlantingReadRow = typeof planting.$inferSelect &
  Omit<PlantingWithReferences, "id">;

const plantingRelationFields = (row: PlantingReadRow) => {
  if (!row.plant?.shortcode)
    throw new Error("Planting plant reference was not loaded");
  return {
    plantId: parseShortcodeFor("plant", row.plant.shortcode),
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
  };
};

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

export { plantingDisplayName } from "~/server/domains/plant/repo/windows";

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

const entryPlantingFields = (links: GardenEntryWithReferences["plantings"]) => {
  const plantings = links
    .flatMap((link) => (link.planting ? [link.planting] : []))
    .sort((left, right) => left.shortcode.localeCompare(right.shortcode));
  return {
    plantingIds: plantings.map((linked) =>
      parseShortcodeFor("planting", linked.shortcode),
    ),
    plantings: plantings.map((linked) => ({
      id: parseShortcodeFor("planting", linked.shortcode),
      name: plantingDisplayName(linked.plant),
    })),
  };
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
  await assertLiveLinkEndpoints(tx, "gardenEntryPlanting", [
    gardenEntryId,
    ...addIds,
  ]);
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

export const createPlanting = defineMutationWriter({
  entity: "planting",
  read: (
    receipt: MutationReceipt<"planting">,
    db: Database,
    _data: PlantingCreateInput,
    _actor: ActorContext,
  ) => readPlantingById(db, receipt.entityId),
  write: async (
    readOutput,
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
      const taskId = data.taskId
        ? await required(tx, data.taskId, "task")
        : null;
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
        sowedOn: data.season?.start ?? null,
        transplantedOn: data.transplantedOn ?? null,
        finishedOn: data.season?.end ?? null,
      });
      await logAuditEntry(tx, actor, {
        entityKind: "planting",
        entityId: row.id,
        action: "create",
      });
      return readOutput(
        {
          entityId: parseEntityId("planting", row.id),
          shortcode: row.shortcode,
        },
        () => readPlantingById(tx, parseEntityId("planting", row.id)),
      );
    }),
});

export const createGardenEntry = defineMutationWriter({
  entity: "gardenEntry",
  read: (
    receipt: MutationReceipt<"gardenEntry">,
    db: Database,
    _data: GardenEntryCreateInput,
    _actor: ActorContext,
  ) => readGardenEntryById(db, receipt.entityId),
  write: async (
    readOutput,
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
          galleryBinding("gardenEntry"),
          row.id,
          imageIds,
        );
      }
      await logAuditEntry(tx, actor, {
        entityKind: "gardenEntry",
        entityId: row.id,
        action: "create",
      });
      return readOutput(
        {
          entityId: parseEntityId("gardenEntry", row.id),
          shortcode: row.shortcode,
        },
        () => readGardenEntryById(tx, parseEntityId("gardenEntry", row.id)),
      );
    }),
});

/** Every field in the update roster is an ordinary patchable field — no
 * lifecycle guard. `status`/`locationId`/`finishedOn` change like any other
 * column, and the diff on the `model.audit` fields becomes the audit entry
 * `changes`, so the timeline shows what actually moved (not a bare "updated"). */
export const updatePlanting = defineMutationWriter({
  entity: "planting",
  read: async (
    receipt: MutationReceipt<"planting">,
    db: Database,
    _id: PlantingId,
    _data: PlantingUpdateData,
    _actor: ActorContext,
  ) => ({
    planting: await readPlantingById(db, receipt.entityId),
    detachedImageKeys: receipt.detachedImageKeys ?? [],
  }),
  write: async (
    readOutput,
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
        sourceProductId === undefined
          ? before.sourceProductId
          : sourceProductId,
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
        sowedOn:
          data.season === undefined ? undefined : (data.season?.start ?? null),
        transplantedOn: data.transplantedOn,
        finishedOn:
          data.season === undefined ? undefined : (data.season?.end ?? null),
      });
      const updated = await updateLiveAndReturn(tx, planting, values, id);
      const changes = computeChanges(
        {
          ...before,
          season: dateRangeFromDates(before.sowedOn, before.finishedOn),
        },
        {
          ...updated,
          season: dateRangeFromDates(updated.sowedOn, updated.finishedOn),
        },
        [...entityFieldModels.planting.audit],
      );
      if (changes) {
        await logAuditEntry(tx, actor, {
          entityKind: "planting",
          entityId: id,
          action: "update",
          changes,
        });
      }
      return readOutput(
        { entityId: id, shortcode: before.shortcode, detachedImageKeys: [] },
        async () => ({
          planting: await readPlantingById(tx, id),
          detachedImageKeys: [],
        }),
      );
    });
    return result;
  },
  item: (full) => full.planting,
});

type GardenEntryUpdateInput = GardenEntryUpdateData & {
  pendingImageIds?: readonly string[];
  removeImageIds?: readonly string[];
  imageOrder?: readonly string[];
};

/** Every field in the update roster is an ordinary patchable field. */
export const updateGardenEntry = defineMutationWriter({
  entity: "gardenEntry",
  read: (
    receipt: MutationReceipt<"gardenEntry">,
    db: Database,
    _id: GardenEntryId,
    _data: GardenEntryUpdateInput,
    _actor: ActorContext,
  ) => readGardenEntryById(db, receipt.entityId),
  write: async (
    readOutput,
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
        galleryBinding("gardenEntry"),
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
      return readOutput({ entityId: id, shortcode: before.shortcode }, () =>
        readGardenEntryById(tx, id),
      );
    }),
});

export const plantingScaffold = listScaffold("planting", planting, {
  derived: {
    activeSpan: [
      sql`COALESCE(${planting.sowedOn}, ${planting.transplantedOn}, ${householdDaySql(planting.createdAt)})`,
      sql`${planting.finishedOn}`,
    ],
  },
  read: {
    title: sql`(SELECT p."name" FROM "Plant" p WHERE p."id" = "Planting"."plantId")`,
    search: plantingSearch,
    media: true,
    bindings: (bind) => {
      const references = bind.ids(async ({ db, ids }) => {
        const rows = await loadPlantingReferences(db, ids);
        return new Map(rows.map(({ id, ...row }) => [id, row]));
      });
      const withReferences = (
        row: typeof planting.$inferSelect,
        loaded: ReadonlyMap<string, Omit<PlantingWithReferences, "id">>,
      ): PlantingReadRow => {
        const related = loaded.get(row.id);
        if (!related) throw new Error("Planting references were not loaded");
        return { ...row, ...related };
      };
      return [
        references.fields(
          rawPlantingListItemOut.pick({ displayName: true }),
          (row, loaded) => ({
            displayName: plantingDisplayName(withReferences(row, loaded).plant),
          }),
        ),
        references.fields(
          rawPlantingListItemOut.pick({
            plantId: true,
            sourceProductId: true,
            locationId: true,
            taskId: true,
            plantName: true,
            sourceProductName: true,
            locationName: true,
            taskName: true,
          }),
          (row, loaded) => plantingRelationFields(withReferences(row, loaded)),
        ),
        references.fields(
          rawPlantingListItemOut.pick({
            guideSowWindow: true,
            guideTransplantWindow: true,
            expectedHarvestStart: true,
            expectedHarvestEnd: true,
            expectedHarvest: true,
          }),
          (row, loaded) => plantingDerivedFields(withReferences(row, loaded)),
        ),
      ];
    },
  },
});

const plantingReader = createEntityReader<
  unknown,
  RawPlantingOut,
  "planting",
  GardenDb
>({ entity: "planting", scaffold: plantingScaffold, output: rawPlantingOut });
/** One live Planting by internal id; throws `PLANTING_NOT_FOUND`. */
export const readPlantingById = plantingReader.getByID;

const JOURNAL_LINK: EntityLinkKind = "gardenEntryPlanting";

export const gardenEntryScaffold = listScaffold("gardenEntry", gardenEntry, {
  rows: {
    /**
     * A planting's journal always includes its direct live associations. A
     * whole-area entry joins only when it has no live planting associations
     * and was observed at the planting's current location within the
     * planting's own active window.
     */
    journalPlantings: sql`SELECT journal_link."fromEntityId" AS "owner", journal_link."toEntityId" AS "planting"
      FROM "EntityLink" journal_link
      WHERE journal_link."kind" = ${JOURNAL_LINK} AND ${notDeleted("journal_link")}
      UNION ALL
      SELECT entry."id", journal_planting."id"
      FROM "GardenEntry" entry
      JOIN "Planting" journal_planting ON journal_planting."locationId" = entry."locationId"
        AND entry."observedOn" >= COALESCE(journal_planting."sowedOn", journal_planting."transplantedOn", ${householdDaySql(sql`journal_planting."createdAt"`)})
        AND (journal_planting."finishedOn" IS NULL OR entry."observedOn" <= journal_planting."finishedOn")
      WHERE NOT EXISTS (
        SELECT 1 FROM "EntityLink" whole_area_link
        WHERE whole_area_link."fromEntityId" = entry."id"
          AND whole_area_link."kind" = ${JOURNAL_LINK}
          AND ${notDeleted("whole_area_link")}
      )`,
  },
  read: {
    title: sql`initcap("GardenEntry"."kind"::text) || ' · ' || to_char("GardenEntry"."observedOn", 'YYYY-MM-DD') || ' · ' || (SELECT l."name" FROM "Location" l WHERE l."id" = "GardenEntry"."locationId")`,
    search: gardenEntrySearch,
    // `createdAt desc` is a deliberate stable tiebreak — a `tieBreaker`, not
    // a `resolve` special-case, so it can't swallow a second user-requested
    // sort (see `buildOrderBy`'s doc comment).
    tieBreaker: desc(gardenEntry.createdAt),
    media: true,
    bindings: (bind) => {
      const locations = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db).query.gardenEntry.findMany({
          where: inArray(
            gardenEntry.id,
            ids.map((id) => parseEntityId("gardenEntry", id)),
          ),
          columns: { id: true },
          with: { location: { columns: { shortcode: true, name: true } } },
        });
        return new Map(rows.map((row) => [row.id, row.location]));
      });
      const attachments = bind.ids(async ({ db, ids }) => {
        const rows = await unwrapDb(db).query.gardenEntry.findMany({
          where: inArray(
            gardenEntry.id,
            ids.map((id) => parseEntityId("gardenEntry", id)),
          ),
          columns: { id: true },
          with: { images: { with: { image: true } } },
        });
        return new Map(rows.map((row) => [row.id, mapImages(row.images)]));
      });
      const plantings = bind.ids(({ db, ids }) => loadEntryPlantings(db, ids));
      const locationOf = (
        row: { id: string },
        loaded: ReadonlyMap<string, { shortcode: string; name: string }>,
      ) => {
        const location = loaded.get(row.id);
        if (!location) throw new Error("Garden entry location was not loaded");
        return location;
      };
      return [
        locations.fields(
          rawGardenEntryListItemOut.pick({ displayName: true }),
          (row, loaded) => ({
            displayName: gardenEntryDisplayName({
              kind: row.kind,
              observedOn: row.observedOn,
              locationName: locationOf(row, loaded).name,
            }),
          }),
        ),
        locations.fields(
          rawGardenEntryListItemOut.pick({
            locationId: true,
            locationName: true,
          }),
          (row, loaded) => {
            const location = locationOf(row, loaded);
            return {
              locationId: parseShortcodeFor("location", location.shortcode),
              locationName: location.name,
            };
          },
        ),
        plantings.fields(
          rawGardenEntryListItemOut.pick({
            plantingIds: true,
            plantings: true,
          }),
          (row, loaded) => entryPlantingFields(loaded.get(row.id) ?? []),
        ),
        attachments.fields(
          rawGardenEntryListItemOut.pick({ images: true }),
          (row, loaded) => ({ images: loaded.get(row.id) ?? [] }),
        ),
      ];
    },
  },
});

const gardenEntryReader = createEntityReader<
  unknown,
  RawGardenEntryOut,
  "gardenEntry",
  GardenDb
>({
  entity: "gardenEntry",
  scaffold: gardenEntryScaffold,
  output: rawGardenEntryOut,
});
/** One live garden entry by internal id; throws `GARDEN_ENTRY_NOT_FOUND`. */
const readGardenEntryById = gardenEntryReader.getByID;

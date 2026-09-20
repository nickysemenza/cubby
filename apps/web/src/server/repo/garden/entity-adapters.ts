import type { ActorContext } from "@cubby/schemas/context";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  parseEntityId,
  parseShortcodeFor,
  type PlantingId,
} from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { gardenEntryPlanting, planting } from "~/server/db/schema";
import {
  defineEntityAdapter,
  deletedWithImages,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import {
  type AuditEntryInput,
  computeChanges,
  diffUnorderedIdSet,
  logAuditEntries,
} from "~/server/repo/audit-log";
import {
  buildPartialUpdateValues,
  imageCascadeChild,
  imageJoinBindings,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { removeEntity } from "~/server/repo/removal";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  refreshDerivedSearchRefs,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";

import {
  createGardenEntry,
  createPlanting,
  gardenEntryList,
  getGardenEntry,
  getPlanting,
  plantingList,
  updateGardenEntry,
  updatePlanting,
} from ".";

const plantings = bindShortcodeResolver("planting");
const entries = bindShortcodeResolver("gardenEntry");

const PLANTING_DELETE_EDGE_POLICY = {
  "GardenEntryPlanting.plantingId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "A garden entry outlives the planting it described; only that association is detached.",
  },
} as const satisfies IncomingEdgePolicy<"planting", OperationDisposition>;

const GARDEN_ENTRY_DELETE_EDGE_POLICY = {
  "GardenEntryImage.gardenEntryId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description: "Garden entry image associations are removed with the entry.",
  },
  "GardenEntryPlanting.gardenEntryId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Planting associations are removed with the garden entry; plantings remain.",
  },
} as const satisfies IncomingEdgePolicy<"gardenEntry", OperationDisposition>;

type PlantingBulkPatch = {
  status?: "planned" | "growing" | "finished";
  finishedOn?: string | null;
  locationId?: string | null;
};

const raiseMissingLocation = (): never => {
  throw createAppError(
    "REFERENCED_RECORD_MISSING",
    "The selected location no longer exists.",
  );
};

/**
 * Mirrors `updateTasksInBulk` (`repo/task/crud.ts`): one complete patch, one
 * transaction, per-row audit `changes` computed on the `model.bulk` roster
 * (`status`, `finishedOn`, `locationId`).
 */
const updatePlantingsInBulk = async (
  db: Database,
  shortcodes: readonly string[],
  data: PlantingBulkPatch,
  actor: ActorContext,
): Promise<{ updatedIds: PlantingId[]; updatedShortcodes: string[] }> => {
  if (new Set(shortcodes).size !== shortcodes.length) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Bulk planting IDs must be unique.",
    );
  }
  const hasPatch =
    data.status !== undefined ||
    data.finishedOn !== undefined ||
    data.locationId !== undefined;
  if (!hasPatch) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A bulk planting patch must supply at least one field.",
    );
  }

  return await withTransaction(db, async (tx: DrizzleTransaction) => {
    const locationId =
      data.locationId === undefined
        ? undefined
        : data.locationId === null
          ? null
          : ((await resolveLiveShortcode(tx, data.locationId, "location")) ??
            raiseMissingLocation());
    const ids = await plantings.all(tx, shortcodes);
    const before = await tx
      .select({
        id: planting.id,
        shortcode: planting.shortcode,
        status: planting.status,
        finishedOn: planting.finishedOn,
        locationId: planting.locationId,
      })
      .from(planting)
      .where(and(inArray(planting.id, ids), notDeleted(planting)))
      .for("update");
    if (before.length !== ids.length) {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "One or more plantings are missing.",
      );
    }

    const values = buildPartialUpdateValues({
      status: data.status,
      finishedOn: data.finishedOn,
      locationId,
    });
    await tx
      .update(planting)
      .set(values)
      .where(and(inArray(planting.id, ids), notDeleted(planting)));

    const auditEntries: AuditEntryInput[] = [];
    for (const row of before) {
      const changes = computeChanges(row, { ...row, ...values }, [
        ...entityFieldModels.planting.bulk,
      ]);
      if (changes) {
        auditEntries.push({
          entityType: "planting",
          entityId: row.id,
          action: "update",
          changes,
        });
      }
    }
    await logAuditEntries(tx, actor, auditEntries);

    return {
      updatedIds: before.map((row) => parseEntityId("planting", row.id)),
      updatedShortcodes: before.map((row) =>
        parseShortcodeFor("planting", row.shortcode),
      ),
    };
  });
};

export const plantingEntityAdapter = defineEntityAdapter({
  entity: "planting",
  lifecycle: { delete: PLANTING_DELETE_EDGE_POLICY },
  repository: {
    get: async (ctx, shortcode) =>
      getPlanting(ctx.db, await plantings.one(ctx.db, shortcode)),
    list: (ctx, filters, sorts, pagination) =>
      plantingList(ctx.readDb, filters, pagination, sorts),
    create: async (ctx, data) => {
      const output = await createPlanting(ctx.db, data, ctx.actorContext);
      return { output, entityId: await plantings.one(ctx.db, output.id) };
    },
    update: async (ctx, shortcode, data) => {
      const id = await plantings.one(ctx.db, shortcode);
      const { planting: output, detachedImageKeys } = await updatePlanting(
        ctx.db,
        id,
        data,
        ctx.actorContext,
      );
      return { output, entityId: id, detachedImageKeys };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await plantings.all(ctx.db, shortcodes);
      const { detachedImageKeys, deletedImageShortcodes, affectedEntryIds } =
        await withTransaction(ctx.db, async (tx) => {
          const affectedEntryRows = await tx
            .select({ gardenEntryId: gardenEntryPlanting.gardenEntryId })
            .from(gardenEntryPlanting)
            .where(
              and(
                inArray(gardenEntryPlanting.plantingId, ids),
                notDeleted(gardenEntryPlanting),
              ),
            );
          const affectedEntryIds = [
            ...new Set(affectedEntryRows.map((row) => row.gardenEntryId)),
          ];
          const beforeRows = affectedEntryIds.length
            ? await tx
                .select({
                  gardenEntryId: gardenEntryPlanting.gardenEntryId,
                  shortcode: planting.shortcode,
                })
                .from(gardenEntryPlanting)
                .innerJoin(
                  planting,
                  eq(planting.id, gardenEntryPlanting.plantingId),
                )
                .where(
                  and(
                    inArray(
                      gardenEntryPlanting.gardenEntryId,
                      affectedEntryIds,
                    ),
                    notDeleted(gardenEntryPlanting),
                    notDeleted(planting),
                  ),
                )
                .orderBy(
                  asc(gardenEntryPlanting.gardenEntryId),
                  asc(planting.shortcode),
                )
            : [];
          const beforeByEntry = new Map<string, string[]>();
          for (const row of beforeRows) {
            const values = beforeByEntry.get(row.gardenEntryId) ?? [];
            values.push(parseShortcodeFor("planting", row.shortcode));
            beforeByEntry.set(row.gardenEntryId, values);
          }
          const result = await removeEntity(tx, {
            entity: "planting",
            ids,
            removal: "soft",
            actor: ctx.actorContext,
            children: [
              {
                table: gardenEntryPlanting,
                parentColumns: [gardenEntryPlanting.plantingId],
                auditKey: "detachedGardenEntries",
              },
            ],
          });
          const afterRows = affectedEntryIds.length
            ? await tx
                .select({
                  gardenEntryId: gardenEntryPlanting.gardenEntryId,
                  shortcode: planting.shortcode,
                })
                .from(gardenEntryPlanting)
                .innerJoin(
                  planting,
                  eq(planting.id, gardenEntryPlanting.plantingId),
                )
                .where(
                  and(
                    inArray(
                      gardenEntryPlanting.gardenEntryId,
                      affectedEntryIds,
                    ),
                    notDeleted(gardenEntryPlanting),
                    notDeleted(planting),
                  ),
                )
                .orderBy(
                  asc(gardenEntryPlanting.gardenEntryId),
                  asc(planting.shortcode),
                )
            : [];
          const afterByEntry = new Map<string, string[]>();
          for (const row of afterRows) {
            const values = afterByEntry.get(row.gardenEntryId) ?? [];
            values.push(parseShortcodeFor("planting", row.shortcode));
            afterByEntry.set(row.gardenEntryId, values);
          }
          await logAuditEntries(
            tx,
            ctx.actorContext,
            [...beforeByEntry.entries()].flatMap(([gardenEntryId, before]) => {
              const changes = diffUnorderedIdSet(
                before,
                afterByEntry.get(gardenEntryId) ?? [],
              );
              return changes
                ? [
                    {
                      entityType: "gardenEntry" as const,
                      entityId: gardenEntryId,
                      action: "update" as const,
                      changes: { plantingIds: changes },
                    },
                  ]
                : [];
            }),
          );
          return { ...result, affectedEntryIds };
        });
      await refreshDerivedSearchRefs(
        ctx.db,
        affectedEntryIds.map((entityId) => ({
          entityType: "gardenEntry" as const,
          entityId,
        })),
        "planting.delete.detachGardenEntries",
      );
      return {
        deletedReferences: deletedWithImages(
          "planting",
          shortcodes,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
    /** One complete patch, one transaction, then one side-effect fan-out. */
    bulkUpdate: async (ctx, ids, data) => {
      const result = await updatePlantingsInBulk(
        ctx.db,
        ids,
        data,
        ctx.actorContext,
      );
      await runMutationSideEffectsForEntities(
        ctx.db,
        mutationEvents(
          "planting",
          "updated",
          result.updatedIds,
          "planting.bulkUpdate",
        ),
      );
      return {
        updatedReferences: entityMutationReferences(
          "planting",
          result.updatedShortcodes,
        ),
      };
    },
  },
});

export const gardenEntryEntityAdapter = defineEntityAdapter({
  entity: "gardenEntry",
  lifecycle: { delete: GARDEN_ENTRY_DELETE_EDGE_POLICY },
  repository: {
    get: async (ctx, shortcode) =>
      getGardenEntry(ctx.db, await entries.one(ctx.db, shortcode)),
    list: (ctx, filters, sorts, pagination) =>
      gardenEntryList(ctx.readDb, filters, pagination, sorts),
    create: async (ctx, data) => {
      const output = await createGardenEntry(ctx.db, data, ctx.actorContext);
      return { output, entityId: await entries.one(ctx.db, output.id) };
    },
    update: async (ctx, shortcode, data) => {
      const id = await entries.one(ctx.db, shortcode);
      return {
        output: await updateGardenEntry(ctx.db, id, data, ctx.actorContext),
        entityId: id,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await entries.all(ctx.db, shortcodes);
      const { detachedImageKeys, deletedImageShortcodes } =
        await withTransaction(ctx.db, async (tx) => {
          return await removeEntity(tx, {
            entity: "gardenEntry",
            ids,
            removal: "soft",
            actor: ctx.actorContext,
            children: [
              {
                table: gardenEntryPlanting,
                parentColumns: [gardenEntryPlanting.gardenEntryId],
                auditKey: "cascadedPlantings",
              },
              imageCascadeChild(imageJoinBindings.gardenEntry),
            ],
          });
        });
      return {
        deletedReferences: deletedWithImages(
          "gardenEntry",
          shortcodes,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
  },
});

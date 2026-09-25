import type { ActorContext } from "@cubby/schemas/context";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import { gardenEntryPlanting, planting } from "~/server/db/schema";
import {
  bulkUpdatedWithSideEffects,
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { diffUnorderedIdSet, logAuditEntries } from "~/server/repo/audit-log";
import {
  imageCascadeChild,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { bulkPatchEntities } from "~/server/repo/entity-patch";
import { removeEntity } from "~/server/repo/removal";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { refreshDerivedSearchRefs } from "~/server/services/mutation-side-effects";

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
  "EntityAttachment.subjectEntityId": {
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
  outcome?: "succeeded" | "failed" | null;
  finishedOn?: string | null;
  locationId?: string | null;
};

const raiseMissingLocation = (): never => {
  throw createAppError(
    "REFERENCED_RECORD_MISSING",
    "The selected location no longer exists.",
  );
};

const updatePlantingsInBulk = (
  db: Database,
  shortcodes: readonly string[],
  data: PlantingBulkPatch,
  actor: ActorContext,
) =>
  bulkPatchEntities(
    db,
    actor,
    {
      entity: "planting",
      table: planting,
      values: async (tx) => ({
        status: data.status,
        outcome: data.outcome,
        finishedOn: data.finishedOn,
        locationId:
          data.locationId == null
            ? data.locationId
            : ((await resolveLiveShortcode(tx, data.locationId, "location")) ??
              raiseMissingLocation()),
      }),
    },
    shortcodes,
    data,
  );

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
    bulkUpdate: async (ctx, ids, data) =>
      bulkUpdatedWithSideEffects(
        ctx,
        "planting",
        await updatePlantingsInBulk(ctx.db, ids, data, ctx.actorContext),
      ),
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
              imageCascadeChild(),
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

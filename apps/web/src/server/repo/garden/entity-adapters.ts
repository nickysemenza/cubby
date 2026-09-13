import { and, inArray } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  gardenEntry,
  planting,
  plantingLocationPeriod,
} from "~/server/db/schema";
import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { createAppError } from "~/server/errors/app-error";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { removeEntity } from "~/server/repo/removal";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";

import {
  createPlanting,
  gardenEntryList,
  getGardenEntry,
  getPlanting,
  plantingList,
  recordGardenEntry,
  updateGardenEntryDetails,
  updatePlantingDetails,
} from ".";

const plantings = bindShortcodeResolver("planting");
const entries = bindShortcodeResolver("gardenEntry");

const PLANTING_DELETE_EDGE_POLICY = {
  "Planting.parentPlantingId": {
    code: "block-split-history",
    effect: "block",
    description: "A planting with split descendants cannot be deleted.",
  },
  "GardenEntry.plantingId": {
    code: "block-garden-history",
    effect: "block",
    description: "A planting with garden entries cannot be deleted.",
  },
  "PlantingLocationPeriod.plantingId": {
    code: "hard-delete-location-history",
    effect: "hard-delete",
    description:
      "Internal location-period rows are removed with a planting that has no retained entries.",
  },
} as const;

const GARDEN_ENTRY_DELETE_EDGE_POLICY = {
  "GardenEntryImage.gardenEntryId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description: "Garden entry image associations are removed with the entry.",
  },
  "PlantingLocationPeriod.sourceGardenEntryId": {
    code: "block-location-history-source",
    effect: "block",
    description:
      "A structural entry remains attached to confirmed location history.",
  },
} as const;

const assertPlantingsHaveNoRetainedHistory = async (
  tx: DrizzleTransaction,
  ids: readonly string[],
) => {
  const [entries, children] = await Promise.all([
    tx.query.gardenEntry.findMany({
      where: and(
        inArray(gardenEntry.plantingId, [...ids]),
        notDeleted(gardenEntry),
      ),
      columns: { plantingId: true },
    }),
    tx.query.planting.findMany({
      where: and(
        inArray(planting.parentPlantingId, [...ids]),
        notDeleted(planting),
      ),
      columns: { parentPlantingId: true },
    }),
  ]);
  if (entries.length > 0 || children.length > 0) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A planting with retained garden history or split descendants cannot be deleted.",
    );
  }
};

export const plantingEntityAdapter = defineEntityAdapter({
  entity: "planting",
  lifecycle: { delete: PLANTING_DELETE_EDGE_POLICY },
  repository: {
    get: async (ctx, shortcode) =>
      getPlanting(ctx.db, await plantings.one(ctx.db, shortcode)),
    list: (ctx, _filters, sorts, pagination) =>
      plantingList(ctx.readDb, pagination, sorts),
    create: async (ctx, data) => {
      const output = await createPlanting(ctx.db, data, ctx.actorContext);
      return { output, entityId: await plantings.one(ctx.db, output.id) };
    },
    update: async (ctx, shortcode, data) => {
      const id = await plantings.one(ctx.db, shortcode);
      return {
        output: await updatePlantingDetails(ctx.db, id, data, ctx.actorContext),
        entityId: id,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await plantings.all(ctx.db, shortcodes);
      await withTransaction(ctx.db, async (tx) => {
        await assertPlantingsHaveNoRetainedHistory(tx, ids);
        await removeEntity(tx, {
          entity: "planting",
          ids,
          removal: "soft",
          actor: ctx.actorContext,
          children: [
            {
              table: plantingLocationPeriod,
              parentColumns: [plantingLocationPeriod.plantingId],
              mode: "hard",
            },
          ],
        });
      });
      return {
        deletedReferences: entityMutationReferences("planting", shortcodes),
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
    list: (ctx, _filters, sorts, pagination) =>
      gardenEntryList(ctx.readDb, pagination, sorts),
    create: async (ctx, data) => {
      if (data.kind === "move") {
        throw new Error("Move entries are created by planting workflows.");
      }
      const { kind, ...entryData } = data;
      const output = await recordGardenEntry(
        ctx.db,
        {
          ...entryData,
          kind,
          pendingImageIds: data.pendingImageIds ?? [],
        },
        ctx.actorContext,
      );
      return { output, entityId: await entries.one(ctx.db, output.id) };
    },
    update: async (ctx, shortcode, data) => {
      const id = await entries.one(ctx.db, shortcode);
      return {
        output: await updateGardenEntryDetails(
          ctx.db,
          id,
          data,
          ctx.actorContext,
        ),
        entityId: id,
      };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await entries.all(ctx.db, shortcodes);
      await withTransaction(ctx.db, (tx) =>
        removeEntity(tx, {
          entity: "gardenEntry",
          ids,
          removal: "soft",
          actor: ctx.actorContext,
        }),
      );
      return {
        deletedReferences: entityMutationReferences("gardenEntry", shortcodes),
      };
    },
  },
});

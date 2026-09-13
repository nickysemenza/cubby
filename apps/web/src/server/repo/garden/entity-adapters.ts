import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { withTransaction } from "~/server/repo/database-helpers";
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
    code: "block-location-history",
    effect: "block",
    description:
      "A planting with confirmed location history cannot be deleted.",
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

export const plantingEntityAdapter = defineEntityAdapter({
  entity: "planting",
  lifecycle: { delete: PLANTING_DELETE_EDGE_POLICY },
  repository: {
    get: async (ctx, shortcode) =>
      getPlanting(ctx.db, await plantings.one(ctx.db, shortcode)),
    list: (ctx, _filters, sorts, pagination) =>
      plantingList(
        ctx.readDb,
        {
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        sorts,
      ),
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
      await withTransaction(ctx.db, (tx) =>
        removeEntity(tx, {
          entity: "planting",
          ids,
          removal: "soft",
          actor: ctx.actorContext,
        }),
      );
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
      gardenEntryList(
        ctx.readDb,
        {
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        sorts,
      ),
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

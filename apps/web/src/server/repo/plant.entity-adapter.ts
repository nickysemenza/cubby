import { plantOut } from "@cubby/schemas/plant";
import { z } from "zod";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import {
  createPlant,
  deletePlants,
  getPlantByShortcode,
  listPlants,
  mergePlants,
  PLANT_DELETE_EDGE_POLICY,
  PLANT_MERGE_EDGE_POLICY,
  updatePlant,
} from "./plant";

const mergeInput = z.object({
  keepId: ENTITY_SCHEMA_BINDINGS.plant.id,
  mergeIds: z.array(ENTITY_SCHEMA_BINDINGS.plant.id).min(1),
});

const plantMergeSummary = z.object({
  deletedIds: z.array(ENTITY_SCHEMA_BINDINGS.plant.id),
  merged: z.number().int().nonnegative(),
  plantingEdgesRepointed: z.number().int().nonnegative(),
  productEdgesRepointed: z.number().int().nonnegative(),
});

export const plantEntityAdapter = defineEntityAdapter({
  entity: "plant",
  lifecycle: {
    delete: PLANT_DELETE_EDGE_POLICY,
    merge: PLANT_MERGE_EDGE_POLICY,
  },
  repository: {
    get: (ctx, id) => getPlantByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      listPlants(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createPlant(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updatePlant(ctx.db, id, data, ctx.actorContext),
    delete: async (ctx, ids) => {
      await deletePlants(ctx.db, ids, ctx.actorContext);
      return { deletedReferences: entityMutationReferences("plant", ids) };
    },
    bulkUpdate: async (ctx, ids, data) => {
      // A household catalogue is small; one audited update per plant is fine.
      for (const id of ids)
        await updatePlant(ctx.db, id, data, ctx.actorContext);
      return { updatedReferences: entityMutationReferences("plant", ids) };
    },
  },
  merge: {
    input: mergeInput,
    output: z.object({ plant: plantOut, mergeSummary: plantMergeSummary }),
    item: (output) => output.plant,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const { mergeSummary } = await mergePlants(
        ctx.db,
        input,
        ctx.actorContext,
      );
      const plant = await getPlantByShortcode(ctx.db, input.keepId);
      if (!plant) throw new Error("Merged Plant keeper disappeared");
      return {
        output: { plant, mergeSummary },
        entityId: null,
        detachedImageKeys: [],
      };
    },
  },
});

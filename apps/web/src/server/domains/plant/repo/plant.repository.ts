import { plantOut } from "@cubby/schemas/plant";
import { z } from "zod";

import {
  asActor,
  defineRepository,
  listOn,
  listReadOn,
  onDb,
} from "~/server/entity-kernel/repo/repository";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import {
  createPlant,
  getPlantByShortcode,
  listPlants,
  listPlantsRead,
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

export const plantRepository = defineRepository("plant", {
  updatePolicy: { recordFields: [] },
  lifecycle: {
    delete: PLANT_DELETE_EDGE_POLICY,
    merge: PLANT_MERGE_EDGE_POLICY,
  },
  get: onDb(getPlantByShortcode),
  list: listOn(listPlants),
  listRead: listReadOn(listPlantsRead),
  create: asActor(createPlant),
  update: asActor(updatePlant),
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

import { plantRawOut as rawPlantOut } from "@cubby/schemas/entity-contracts/plant";
import { z } from "zod";

import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";

import {
  createPlant,
  mergePlants,
  PLANT_DELETE_EDGE_POLICY,
  PLANT_MERGE_EDGE_POLICY,
  plantScaffold,
  readPlant,
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
  scaffold: plantScaffold,
  create: asActor(createPlant),
  update: asActor(updatePlant),
  merge: {
    input: mergeInput,
    output: z.object({ plant: rawPlantOut, mergeSummary: plantMergeSummary }),
    item: (output) => output.plant,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const { mergeSummary } = await mergePlants(
        ctx.db,
        input,
        ctx.actorContext,
      );
      const plant = await readPlant(ctx.db, input.keepId);
      if (!plant) throw new Error("Merged Plant keeper disappeared");
      return {
        output: { plant, mergeSummary },
        entityId: null,
        detachedImageKeys: [],
      };
    },
  },
});

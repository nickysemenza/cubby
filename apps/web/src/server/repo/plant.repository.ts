import type { PlantId } from "@cubby/schemas/identifiers";
import { plantOut } from "@cubby/schemas/plant";
import { z } from "zod";

import { entityMutationReferences } from "~/server/entity-kernel/adapter";
import { ENTITY_SCHEMA_BINDINGS } from "~/server/generated/entity-bindings.gen";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";

import {
  createPlant,
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

export const plantRepository = defineRepository("plant", {
  lifecycle: {
    delete: PLANT_DELETE_EDGE_POLICY,
    merge: PLANT_MERGE_EDGE_POLICY,
  },
  get: onDb(getPlantByShortcode),
  list: listOn(listPlants),
  create: asActor(createPlant),
  update: asActor(updatePlant),
  bulkUpdate: async (ctx, ids, data) => {
    // A household catalogue is small; one audited update per plant is fine.
    // One transaction, so a failing plant leaves the whole patch unapplied;
    // its projections refresh inside it and the embedding tasks publish
    // after its commit.
    await withTransactionDatabase(ctx.db, async (transactionDb) => {
      const entityIds: PlantId[] = [];
      for (const id of ids) {
        const { entityId } = await updatePlant(
          transactionDb,
          id,
          data,
          ctx.actorContext,
        );
        entityIds.push(entityId);
      }
      await runMutationSideEffectsForEntities(
        transactionDb,
        mutationEvents("plant", "updated", entityIds, "plant.bulkUpdate"),
      );
    });
    return { updatedReferences: entityMutationReferences("plant", ids) };
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

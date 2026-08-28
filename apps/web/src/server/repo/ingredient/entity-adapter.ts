import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  ingredientMergeInput,
  ingredientOut,
  mergeSummary as ingredientMergeSummary,
  ingredientSortableFields,
} from "@cubby/schemas/ingredient";
import { z } from "zod";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import {
  bindShortcodeResolver,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { getIngredientByID as getIngredientDetail } from "~/server/services/ingredient.service";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

import { createIngredient, getIngredientByID, updateIngredient } from "./crud";
import { deleteIngredients, INGREDIENT_DELETE_EDGE_POLICY } from "./deletion";
import { INGREDIENT_MERGE_EDGE_POLICY, mergeIngredients } from "./merge";
import { ingredientList } from "./search";

const ingredientShortcodes = bindShortcodeResolver("ingredient");

export const ingredientEntityAdapter = defineEntityAdapter({
  entity: "ingredient",
  sort: { fields: ingredientSortableFields, default: "createdAt" },
  lifecycle: {
    delete: INGREDIENT_DELETE_EDGE_POLICY,
    merge: INGREDIENT_MERGE_EDGE_POLICY,
  },
  repository: {
    get: async (ctx, shortcode) => {
      const id = await resolveLiveShortcode(ctx.db, shortcode, "ingredient");
      return id
        ? getIngredientDetail(
            ctx.db,
            ctx.usdaClient,
            parseEntityId("ingredient", id),
          )
        : null;
    },
    list: (ctx, filters, sorts, pagination) =>
      ingredientList(ctx.db, filters, sorts, pagination),
    create: async (ctx, data) => {
      const output = await createIngredient(ctx.db, data, ctx.actorContext);
      return {
        output,
        entityId: await ingredientShortcodes.one(ctx.db, output.id),
      };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await ingredientShortcodes.one(ctx.db, shortcode);
      const output = await updateIngredient(
        ctx.db,
        entityId,
        data,
        ctx.actorContext,
      );
      const backgroundBatches =
        await ctx.services.recipeCosting.recomputeForIngredient(entityId, {
          source: "ingredient.update",
          entity: { entityType: "ingredient", entityId },
        });
      return { output, entityId, backgroundBatches };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await ingredientShortcodes.all(ctx.db, shortcodes);
      await deleteIngredients(ctx.db, ids, ctx.actorContext);
      const backgroundBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        ids.map((entityId) => ({
          action: "deleted" as const,
          entity: { entityType: "ingredient" as const, entityId },
          source: "ingredient.delete",
        })),
      );
      return {
        deletedReferences: entityMutationReferences("ingredient", shortcodes),
        backgroundBatches,
      };
    },
  },
  merge: {
    input: ingredientMergeInput,
    output: z.object({
      ingredient: ingredientOut,
      mergeSummary: ingredientMergeSummary,
    }),
    item: (output) => output.ingredient,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const summary = await mergeIngredients(ctx.db, input, ctx.actorContext);
      const entityId = await ingredientShortcodes.one(ctx.db, input.keepId);
      const backgroundBatches = [
        ...(await ctx.services.recipeCosting.dispatchRecompute(
          summary.affectedRecipeIds,
          {
            source: "ingredient.merge",
            entity: { entityType: "ingredient", entityId },
          },
        )),
        ...(await runMutationSideEffectsForEntities(
          ctx.db,
          summary.deletedEntityIds.map((deletedEntityId) => ({
            action: "deleted" as const,
            entity: {
              entityType: "ingredient" as const,
              entityId: deletedEntityId,
            },
            source: "ingredient.merge",
          })),
        )),
      ];
      return {
        output: {
          ingredient: await getIngredientByID(ctx.db, entityId),
          mergeSummary: ingredientMergeSummary.parse(summary),
        },
        entityId,
        detachedImageKeys: [],
        backgroundBatches,
      };
    },
  },
});

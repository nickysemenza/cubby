import { recipeSortableFields } from "@cubby/schemas/recipe";

import {
  defineEntityAdapter,
  entityMutationReferences,
} from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

import {
  createRecipe,
  deleteRecipes,
  getRecipeByShortcode,
  RECIPE_DELETE_EDGE_POLICY,
  recipeList,
  updateRecipe,
} from "./crud";
import { findParentRecipeIdsBatch } from "./totals";

const recipeShortcodes = bindShortcodeResolver("recipe");

export const recipeEntityAdapter = defineEntityAdapter({
  entity: "recipe",
  sort: {
    fields: recipeSortableFields,
    default: "createdAt",
    groupable: ["name"],
  },
  lifecycle: { delete: RECIPE_DELETE_EDGE_POLICY },
  repository: {
    get: (ctx, id) => getRecipeByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      recipeList(ctx.db, filters, sorts, pagination),
    create: async (ctx, data) => {
      const output = await createRecipe(ctx.db, data, ctx.actorContext);
      const entityId = await recipeShortcodes.one(ctx.db, output.id);
      const backgroundBatches =
        await ctx.services.recipeCosting.dispatchRecompute([entityId], {
          source: "recipe.create",
          entity: { entityType: "recipe", entityId },
        });
      return { output, entityId, backgroundBatches };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await recipeShortcodes.one(ctx.db, shortcode);
      const { recipe: output, detachedImageKeys } = await updateRecipe(
        ctx.db,
        entityId,
        data,
        ctx.actorContext,
      );
      const backgroundBatches =
        await ctx.services.recipeCosting.dispatchRecompute([entityId], {
          source: "recipe.update",
          entity: { entityType: "recipe", entityId },
        });
      return { output, entityId, detachedImageKeys, backgroundBatches };
    },
    delete: async (ctx, shortcodes) => {
      const ids = await recipeShortcodes.all(ctx.db, shortcodes);
      const deletedSet = new Set(ids);
      const parentsByRecipe = await findParentRecipeIdsBatch(ctx.db, ids);
      const parentIds = [
        ...new Set(
          [...parentsByRecipe.values()]
            .flat()
            .filter((id) => !deletedSet.has(id)),
        ),
      ];
      const { detachedImageKeys, deletedImageShortcodes } = await deleteRecipes(
        ctx.db,
        ids,
        ctx.actorContext,
      );
      const [backgroundBatches, recipeBatches] = await Promise.all([
        runMutationSideEffectsForEntities(
          ctx.db,
          ids.map((entityId) => ({
            action: "deleted" as const,
            entity: { entityType: "recipe" as const, entityId },
            source: "recipe.delete",
          })),
        ),
        parentIds.length > 0
          ? ctx.services.recipeCosting.dispatchRecompute(parentIds, {
              source: "recipe.delete",
            })
          : Promise.resolve([]),
      ]);
      return {
        deletedReferences: [
          ...entityMutationReferences("recipe", shortcodes),
          ...entityMutationReferences("image", deletedImageShortcodes),
        ],
        detachedImageKeys,
        backgroundBatches: [...backgroundBatches, ...recipeBatches],
      };
    },
  },
});

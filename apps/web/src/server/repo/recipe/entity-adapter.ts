import {
  defineEntityAdapter,
  deletedWithImages,
} from "~/server/entity-kernel/adapter";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { repairStaleRecipesForRead } from "~/server/services/repair-stale-recipes-for-read";

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
  lifecycle: { delete: RECIPE_DELETE_EDGE_POLICY },
  repository: {
    /**
     * Repair-on-read. A recipe whose totals are stale is recomputed here, in
     * the request, before it is returned: one recipe's WASM pass is
     * milliseconds and USDA is cached, so the page never shows "pending" for
     * a wakeup the queue lost. Its stale parents are published, not cascaded
     * inline, so the read stays bounded to one recipe. The probe and the
     * post-repair read go through the service's strong handle: on a browser
     * read `ctx.db` is the bounded-stale (Hyperdrive-cached) adapter and
     * would hand back the pre-repair row for up to 60s. The repair is
     * best-effort: the persisted row still reads as pending and the queue /
     * "Settle now" remain the durable healers, and failing the GET would only
     * re-run the same failing repair on every later read.
     */
    get: async (ctx, id) => {
      const [entityId] = await recipeShortcodes.present(ctx.db, [id]);
      if (!entityId) return null;
      const strongDb = ctx.services.recipeCosting.database;
      const repaired = await repairStaleRecipesForRead(
        ctx.services.recipeCosting,
        [entityId],
        "recipe.get",
      );
      return getRecipeByShortcode(repaired ? strongDb : ctx.db, id);
    },
    list: (ctx, filters, sorts, pagination) =>
      recipeList(ctx.db, filters, sorts, pagination),
    create: async (ctx, data) => {
      const output = await createRecipe(ctx.db, data, ctx.actorContext);
      const entityId = await recipeShortcodes.one(ctx.db, output.id);
      await ctx.services.recipeCosting.dispatchRecompute([entityId], {
        source: "recipe.create",
        entity: { entityType: "recipe", entityId },
      });
      return { output, entityId };
    },
    update: async (ctx, shortcode, data) => {
      const entityId = await recipeShortcodes.one(ctx.db, shortcode);
      const { recipe: output, detachedImageKeys } = await updateRecipe(
        ctx.db,
        entityId,
        data,
        ctx.actorContext,
      );
      await ctx.services.recipeCosting.dispatchRecompute([entityId], {
        source: "recipe.update",
        entity: { entityType: "recipe", entityId },
      });
      return { output, entityId, detachedImageKeys };
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
      await Promise.all([
        runMutationSideEffectsForEntities(
          ctx.db,
          mutationEvents("recipe", "deleted", ids, "recipe.delete"),
        ),
        parentIds.length > 0
          ? ctx.services.recipeCosting.dispatchRecompute(parentIds, {
              source: "recipe.delete",
            })
          : Promise.resolve(0),
      ]);
      return {
        deletedReferences: deletedWithImages(
          "recipe",
          shortcodes,
          deletedImageShortcodes,
        ),
        detachedImageKeys,
      };
    },
  },
});

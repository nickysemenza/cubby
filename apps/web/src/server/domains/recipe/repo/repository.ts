import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import {
  defineRepository,
  listOn,
} from "~/server/entity-kernel/repo/repository";
import { bindShortcodeResolver } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createRecipe,
  deleteRecipes,
  getRecipeByShortcode,
  RECIPE_DELETE_EDGE_POLICY,
  recipeList,
  recipeListRead,
  updateRecipe,
} from "./crud";

const recipeShortcodes = bindShortcodeResolver("recipe");

export const recipeRepository = defineRepository("recipe", {
  lifecycle: { delete: RECIPE_DELETE_EDGE_POLICY },
  get: (ctx, id) => getRecipeByShortcode(ctx.db, id),
  list: listOn(recipeList),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    recipeListRead(ctx.db, filters, sorts, pagination, "page", projection),
  create: async (ctx, data) => {
    const output = await createRecipe(ctx.db, data, ctx.actorContext);
    const entityId = await recipeShortcodes.one(ctx.db, output.id);
    await ctx.services.recipeCosting.dispatchRecompute([entityId], {
      source: "recipe.create",
      entity: { entityKind: "recipe", entityId },
    });
    return { output, entityId };
  },
  createRead: async (ctx, data, fields) => {
    const result = await createRecipe.read(
      fields,
      ctx.db,
      data,
      ctx.actorContext,
    );
    await ctx.services.recipeCosting.dispatchRecompute([result.entityId], {
      source: "recipe.create",
      entity: { entityKind: "recipe", entityId: result.entityId },
    });
    return result;
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
      entity: { entityKind: "recipe", entityId },
    });
    return { output, entityId, detachedImageKeys };
  },
  updateRead: async (ctx, shortcode, data, fields) => {
    const entityId = await recipeShortcodes.one(ctx.db, shortcode);
    const result = await updateRecipe.read(
      fields,
      ctx.db,
      entityId,
      data,
      ctx.actorContext,
    );
    await ctx.services.recipeCosting.dispatchRecompute([entityId], {
      source: "recipe.update",
      entity: { entityKind: "recipe", entityId },
    });
    return result;
  },
  delete: async (ctx, shortcodes) => {
    const ids = await recipeShortcodes.all(ctx.db, shortcodes);
    const result = await deleteRecipes(ctx.db, ids, ctx.actorContext);
    await runMutationSideEffectsForEntities(
      ctx.db,
      mutationEvents("recipe", "deleted", ids, "recipe.delete"),
    );
    return result;
  },
});

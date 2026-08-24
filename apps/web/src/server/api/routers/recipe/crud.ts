import {
  recipeGraphListOut,
  recipeIdInput,
  recipeIdsInput,
  recipeListItemOut,
  recipeTagsOut,
  recipeWithSideEffectsOut,
} from "@cubby/schemas/recipe";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { ENTITY_KERNEL_BINDINGS } from "~/server/entity-kernel/registry";
import {
  duplicateRecipe,
  getAllTags,
  getRecipesByIDs,
} from "~/server/repo/recipe";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { createEntityCompatibilityProcedures } from "../../entity-compatibility";
import { protectedProcedure, strictOutput } from "../../trpc";

const recipeShortcodes = bindShortcodeResolver("recipe");

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createEntityCompatibilityProcedures(ENTITY_KERNEL_BINDINGS.recipe, {
  ...ENTITY_BINDINGS.recipe.crud,
  listOutput: recipeListItemOut,
});

// Batched fetch by id — mirrors ingredient.getManyByIDs. Used by client-side
// cost rollup to resolve sub-recipes (recipe-as-ingredient) without an N+1
// fan-out of getByID calls. Missing/deleted ids are omitted from the result.
const getManyByIDs = protectedProcedure
  .input(recipeIdsInput)
  .output(strictOutput(recipeGraphListOut))
  .query(async ({ ctx, input }) => {
    return await getRecipesByIDs(
      ctx.db,
      await recipeShortcodes.all(ctx.db, input.ids),
    );
  });

const getAllTagsEndpoint = protectedProcedure
  .output(strictOutput(recipeTagsOut))
  .query(async ({ ctx }) => {
    return await getAllTags(ctx.db);
  });

// Clone a recipe's whole graph (sections, ingredients, images) as a new
// recipe named "<name> (copy)". Mirrors `create`'s post-write side effects
// (recompute + mutation side effects) since it's a fresh recipe by another
// name.
const duplicate = protectedProcedure
  .input(recipeIdInput)
  .output(strictOutput(recipeWithSideEffectsOut))
  .mutation(async ({ ctx, input }) => {
    const sourceId = await recipeShortcodes.one(ctx.db, input.id);
    const duplicated = await duplicateRecipe(
      ctx.db,
      sourceId,
      ctx.actorContext,
    );
    const entityId = await recipeShortcodes.one(ctx.db, duplicated.id);
    const recipeBatches = await ctx.services.recipeCosting.dispatchRecompute(
      [entityId],
      {
        source: "recipe.duplicate",
        entity: { entityType: "recipe", entityId },
      },
    );
    const backgroundBatches = await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "recipe", entityId },
      source: "recipe.duplicate",
    });
    return {
      ...duplicated,
      sideEffects: {
        backgroundBatches: [...recipeBatches, ...backgroundBatches],
      },
    };
  });

export const recipeCrudProcedures = {
  getByID,
  getManyByIDs,
  list,
  create,
  update,
  duplicate,
  delete: deleteItem,
  getAllTags: getAllTagsEndpoint,
};

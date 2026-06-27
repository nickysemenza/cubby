/**
 * Recipe CRUD procedures.
 *
 * Standard create / read / update / delete plus the by-shortcode, batched
 * by-id, and tag-listing reads. Split out of the recipe router god file; paths
 * are re-composed flat in `../recipe.ts`, so client procedure paths
 * (`recipe.list`, `recipe.getByID`, …) are unchanged.
 */

import { type RecipeId, recipeId } from "@cubby/schemas/identifiers";
import {
  recipeCreateInput,
  recipeFiltersSchema,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import {
  recipeGraphOut,
  recipeListItemOut,
  recipeOut,
} from "@cubby/schemas/recipe-responses";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  createRecipe,
  deleteRecipes,
  getAllTags,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipesByIDs,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../../crud-factory";
import { protectedProcedure } from "../../trpc";

// Create standardized CRUD procedures using factory
// List returns the lean summary (no section graph); detail keeps full recipeOut — split the factory so each carries its own output schema.
const { list } = createEntityListProcedure({
  schemas: { output: recipeListItemOut, filters: recipeFiltersSchema },
  repository: {
    list: async (services, filters, sort, pagination) => {
      return await recipeList(services.db, filters, sort, pagination);
    },
  },
  entityName: "recipe",
});

const { getByID, create, update } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: recipeCreateInput,
    updateInput: recipeUpdateInput.shape.data,
    output: recipeOut,
    idSchema: recipeId,
  },
  repository: {
    getByID: async (services, id: RecipeId) => {
      const res = await getRecipeByID(services.db, id);
      if (res === null) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      return res;
    },
    create: async (services, data) => {
      const created = await createRecipe(
        services.db,
        data,
        services.actorContext,
      );
      // One new recipe — under the queue threshold, so this recomputes inline
      // (instant totals) + nulls any parents.
      await services.services.recipeCosting.dispatchRecompute([
        created.id as RecipeId,
      ]);
      return created;
    },
    update: async (services, id: RecipeId, data) => {
      const updated = await updateRecipe(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await services.services.recipeCosting.dispatchRecompute([id]);
      return updated;
    },
  },
});

// Get recipe by shortcode (e.g., R-X7K9)
const getByShortcode = protectedProcedure
  .input(z.object({ shortcode: z.string() }))
  .output(recipeOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getRecipeByShortcode(ctx.db, input.shortcode);
  });

// Batched fetch by id — mirrors ingredient.getManyByIDs. Used by client-side
// cost rollup to resolve sub-recipes (recipe-as-ingredient) without an N+1
// fan-out of getByID calls. Missing/deleted ids are omitted from the result.
const getManyByIDs = protectedProcedure
  .input(z.object({ ids: z.array(recipeId) }))
  .output(z.array(recipeGraphOut))
  .query(async ({ ctx, input }) => {
    return await getRecipesByIDs(ctx.db, input.ids);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<RecipeId>(async (services, ids) => {
  await deleteRecipes(services.db, ids, services.actorContext);
}, recipeId);

const getAllTagsEndpoint = protectedProcedure
  .output(z.array(z.string()))
  .query(async ({ ctx }) => {
    return await getAllTags(ctx.db);
  });

export const recipeCrudProcedures = {
  getByID,
  getByShortcode,
  getManyByIDs,
  list,
  create,
  update,
  delete: deleteItem,
  getAllTags: getAllTagsEndpoint,
};

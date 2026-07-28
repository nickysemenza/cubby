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
  recipeGraphListOut,
  recipeIdsInput,
  recipeListItemOut,
  recipeOut,
  recipeShortcodeInput,
  recipeSortableFields,
  recipeTagsOut,
  recipeUpdateData,
  recipeWithSideEffectsOut,
} from "@cubby/schemas/recipe";
import { uniq } from "es-toolkit";
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
import { findParentRecipeIdsBatch } from "~/server/repo/recipe/totals";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../../crud-factory";
import { protectedProcedure } from "../../trpc";

// Create standardized CRUD procedures using factory
// List returns the lean summary (no section graph); detail keeps full recipeOut — split the factory so each carries its own output schema.
const { list } = createEntityListProcedure({
  schemas: {
    output: recipeListItemOut,
    filters: recipeFiltersSchema,
    sort: {
      sortableFields: recipeSortableFields,
      defaultSort: "createdAt",
      groupableFields: ["name"] as const,
    },
  },
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
    updateInput: recipeUpdateData,
    output: recipeOut,
    createOutput: recipeWithSideEffectsOut,
    updateOutput: recipeWithSideEffectsOut,
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
      // Persist recompute work through the background dispatcher. In dev this
      // still drains inline, but the operation is visible on Background Jobs.
      const recipeBatches =
        await services.services.recipeCosting.dispatchRecompute([created.id], {
          source: "recipe.create",
          entity: { entityType: "recipe", entityId: created.id },
        });
      const backgroundBatches = await runMutationSideEffects(services.db, {
        action: "created",
        entity: { entityType: "recipe", entityId: created.id },
        source: "recipe.create",
      });
      return {
        ...created,
        sideEffects: {
          backgroundBatches: [...recipeBatches, ...backgroundBatches],
        },
      };
    },
    update: async (services, id: RecipeId, data) => {
      const updated = await updateRecipe(
        services.db,
        id,
        data,
        services.actorContext,
      );
      const recipeBatches =
        await services.services.recipeCosting.dispatchRecompute([id], {
          source: "recipe.update",
          entity: { entityType: "recipe", entityId: id },
        });
      const backgroundBatches = await runMutationSideEffects(services.db, {
        action: "updated",
        entity: { entityType: "recipe", entityId: id },
        source: "recipe.update",
      });
      return {
        ...updated,
        sideEffects: {
          backgroundBatches: [...recipeBatches, ...backgroundBatches],
        },
      };
    },
  },
});

// Get recipe by shortcode (e.g., R-X7K9)
const getByShortcode = protectedProcedure
  .input(recipeShortcodeInput)
  .output(recipeOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getRecipeByShortcode(ctx.db, input.shortcode);
  });

// Batched fetch by id — mirrors ingredient.getManyByIDs. Used by client-side
// cost rollup to resolve sub-recipes (recipe-as-ingredient) without an N+1
// fan-out of getByID calls. Missing/deleted ids are omitted from the result.
const getManyByIDs = protectedProcedure
  .input(recipeIdsInput)
  .output(recipeGraphListOut)
  .query(async ({ ctx, input }) => {
    return await getRecipesByIDs(ctx.db, input.ids);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<RecipeId>(async (services, ids) => {
  // Resolve parent recipes (recipe-as-ingredient) BEFORE deleting: a deleted
  // sub-recipe's cost is baked into every parent's persisted totals, but the
  // recipe manifest has onDelete: [] and needsValuationRecompute is false for
  // recipe, so nothing else marks parents stale. Every other cost-affecting
  // mutation propagates staleness; delete must too (F2). Resolve first so the
  // link rows are still live when we walk them.
  const deletedSet = new Set<RecipeId>(ids);
  const parentsByRecipe = await findParentRecipeIdsBatch(services.db, ids);
  const parentIds = uniq(
    [...parentsByRecipe.values()].flat().filter((id) => !deletedSet.has(id)),
  );

  await deleteRecipes(services.db, ids, services.actorContext);
  const sideEffectBatches = await runMutationSideEffectsForEntities(
    services.db,
    ids.map((id) => ({
      action: "deleted" as const,
      entity: { entityType: "recipe" as const, entityId: id },
      source: "recipe.delete",
    })),
  );

  // dispatchRecompute marks parents stale in-tx, then cascades to grandparents —
  // the same propagation path recipe.update uses.
  const recomputeBatches =
    parentIds.length > 0
      ? await services.services.recipeCosting.dispatchRecompute(parentIds, {
          source: "recipe.delete",
        })
      : [];

  return [...sideEffectBatches, ...recomputeBatches];
}, recipeId);

const getAllTagsEndpoint = protectedProcedure
  .output(recipeTagsOut)
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

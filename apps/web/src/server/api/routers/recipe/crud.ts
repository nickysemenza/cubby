/**
 * Recipe CRUD procedures.
 *
 * Standard create / read / update / delete plus the by-shortcode, batched
 * by-id, and tag-listing reads. Split out of the recipe router god file; paths
 * are re-composed flat in `../recipe.ts`, so client procedure paths
 * (`recipe.list`, `recipe.getByID`, …) are unchanged.
 */

import {
  type CookbookId,
  type CookbookShortcode,
  type RecipeId,
  type RecipeShortcode,
  recipeShortcode,
  unsafeCookbookId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import {
  recipeCreateInput,
  recipeFiltersSchema,
  recipeGraphListOut,
  recipeIdsInput,
  recipeListItemOut,
  recipeOut,
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
  resolveLiveShortcode,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";
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

const resolveRecipeEntityId = async (
  db: Parameters<typeof resolveLiveShortcode>[0],
  shortcode: RecipeShortcode,
): Promise<RecipeId> => {
  const id = await resolveLiveShortcode(db, shortcode, "recipe");
  if (!id) {
    throw createAppError("RECIPE_NOT_FOUND", `Recipe ${shortcode} not found`);
  }
  return unsafeRecipeId(id);
};

const resolveRecipeEntityIds = async (
  db: Parameters<typeof resolveLiveShortcodes>[0],
  shortcodes: RecipeShortcode[],
): Promise<RecipeId[]> => {
  const resolved = await resolveLiveShortcodes(db, shortcodes, "recipe");
  return shortcodes.map((shortcode) => {
    const id = resolved.get(shortcode);
    if (!id) {
      throw createAppError("RECIPE_NOT_FOUND", `Recipe ${shortcode} not found`);
    }
    return unsafeRecipeId(id);
  });
};

const resolveCookbookFilter = async (
  db: Parameters<typeof resolveLiveShortcodes>[0],
  value: CookbookShortcode | CookbookShortcode[] | undefined,
): Promise<CookbookId | CookbookId[] | undefined> => {
  if (value === undefined) return undefined;
  const shortcodes = Array.isArray(value) ? value : [value];
  const resolved = await resolveLiveShortcodes(db, shortcodes, "cookbook");
  const ids = shortcodes.map((shortcode) => {
    const id = resolved.get(shortcode);
    if (!id) {
      throw createAppError(
        "COOKBOOK_NOT_FOUND",
        `Cookbook ${shortcode} not found`,
      );
    }
    return unsafeCookbookId(id);
  });
  return Array.isArray(value) ? ids : ids[0];
};

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
      return await recipeList(
        services.db,
        {
          ...filters,
          cookbookId: await resolveCookbookFilter(
            services.db,
            filters.cookbookId,
          ),
        },
        sort,
        pagination,
      );
    },
  },
  entityName: "recipe",
});

const { getByID, getByShortcode, create, update } =
  createEntityCrudWithoutListProcedures({
    entityName: "recipe",
    schemas: {
      createInput: recipeCreateInput,
      updateInput: recipeUpdateData,
      output: recipeOut,
      createOutput: recipeWithSideEffectsOut,
      updateOutput: recipeWithSideEffectsOut,
      idSchema: recipeShortcode,
    },
    repository: {
      getByID: async (services, id: RecipeShortcode) => {
        const res = await getRecipeByID(
          services.db,
          await resolveRecipeEntityId(services.db, id),
        );
        if (res === null) {
          throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
        }
        return res;
      },
      getByShortcode: (services, shortcode) =>
        getRecipeByShortcode(services.db, shortcode),
      create: async (services, data) => {
        const created = await createRecipe(
          services.db,
          data,
          services.actorContext,
        );
        const entityId = await resolveRecipeEntityId(services.db, created.id);
        // Persist recompute work through the background dispatcher. In dev this
        // still drains inline, but the operation is visible on Background Jobs.
        const recipeBatches =
          await services.services.recipeCosting.dispatchRecompute([entityId], {
            source: "recipe.create",
            entity: { entityType: "recipe", entityId },
          });
        const backgroundBatches = await runMutationSideEffects(services.db, {
          action: "created",
          entity: { entityType: "recipe", entityId },
          source: "recipe.create",
        });
        return {
          ...created,
          sideEffects: {
            backgroundBatches: [...recipeBatches, ...backgroundBatches],
          },
        };
      },
      update: async (services, shortcode: RecipeShortcode, data) => {
        const id = await resolveRecipeEntityId(services.db, shortcode);
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

// Batched fetch by id — mirrors ingredient.getManyByIDs. Used by client-side
// cost rollup to resolve sub-recipes (recipe-as-ingredient) without an N+1
// fan-out of getByID calls. Missing/deleted ids are omitted from the result.
const getManyByIDs = protectedProcedure
  .input(recipeIdsInput)
  .output(recipeGraphListOut)
  .query(async ({ ctx, input }) => {
    return await getRecipesByIDs(
      ctx.db,
      await resolveRecipeEntityIds(ctx.db, input.ids),
    );
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<RecipeShortcode>(
  async (services, shortcodes) => {
    const ids = await resolveRecipeEntityIds(services.db, shortcodes);
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
  },
  recipeShortcode,
);

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

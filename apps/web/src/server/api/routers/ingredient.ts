/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  type IngredientId,
  ingredientId,
  recipeId,
} from "@cubby/schemas/identifiers";
import {
  enrichmentRowsOut,
  ingredientCreateInput,
  ingredientFiltersSchema,
  ingredientIdInput,
  ingredientIdsInput,
  ingredientListItemOut,
  ingredientMatchesOut,
  ingredientMergeImpactInput,
  ingredientMergeImpactOut,
  ingredientMergeInput,
  ingredientMergeOut,
  ingredientNameFilterInput,
  ingredientNamesInput,
  ingredientRawLinesInput,
  ingredientRawLinesOut,
  ingredientRecipeUsagesOut,
  ingredientResolvableNamesInput,
  ingredientResolveOrCreateOut,
  ingredientSortableFields,
  ingredientUpdateData,
  ingredientUpdateInput,
  ingredientWithFoodAndSideEffectsOut,
  ingredientWithFoodLeanListOut,
  ingredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import { z } from "zod";
import {
  deleteIngredients,
  getIngredientMatches,
  getRawLinesForIngredients,
  getRecipeUsagesForIngredient,
  ingredientList,
  mergeImpactForIngredients,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import {
  createIngredient as createIngredientService,
  enrichmentWorkbench as enrichmentWorkbenchService,
  getIngredientByID,
  getIngredientByName,
  getIngredientsByIDs,
  mergeIngredients,
  updateIngredient as updateIngredientService,
} from "~/server/services/ingredient.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudWithoutListProcedures,
  createEntityListProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Create standardized CRUD procedures using factory (update is customized below
// so it can eagerly recompute dependent recipes and report the side-effects).
// List returns a lean summary (lean ingredient + food + {id,name} recipe refs, no
// per-usage recipe bodies); detail (getByID/create) keeps the full
// ingredientWithFoodOut. Split into the two sub-factories so each surface carries
// its own output schema. (update is customized below.)
const { list } = createEntityListProcedure({
  schemas: {
    output: ingredientListItemOut,
    filters: ingredientFiltersSchema,
    sort: {
      sortableFields: ingredientSortableFields,
      defaultSort: "createdAt",
    },
  },
  repository: {
    // Straight repo call — the list path does no USDA enrichment, so per the
    // service-boundary rule there's no service layer here.
    list: async (services, filters, sort, pagination) => {
      return await ingredientList(
        services.db,
        filters.nameFilter,
        sort,
        pagination,
        filters.missingProductsOnly,
      );
    },
  },
  entityName: "ingredient",
});

const { getByID, create } = createEntityCrudWithoutListProcedures({
  schemas: {
    createInput: ingredientCreateInput,
    updateInput: ingredientUpdateData,
    output: ingredientWithFoodOut,
    createOutput: ingredientWithFoodAndSideEffectsOut,
    idSchema: ingredientId,
  },
  repository: {
    getByID: async (services, id: IngredientId) => {
      return await getIngredientByID(services.db, services.usdaClient, id);
    },
    create: async (services, data) => {
      const ingredient = await createIngredientService(
        services.db,
        services.usdaClient,
        data,
        services.actorContext,
      );
      const backgroundBatches = await runMutationSideEffects(services.db, {
        action: "created",
        entity: { entityType: "ingredient", entityId: ingredient.id },
        source: "ingredient.create",
      });
      return { ...ingredient, sideEffects: { backgroundBatches } };
    },
    update: async (services, id: IngredientId, data) => {
      return await updateIngredientService(
        services.db,
        services.usdaClient,
        id,
        data,
        services.actorContext,
      );
    },
  },
});

// Custom update: an ingredient edit changes its contribution to recipe cost, so
// recompute every dependent recipe eagerly (covers UI + MCP, which both call
// through this proc) and report the count.
const update = protectedProcedure
  .input(ingredientUpdateInput)
  .output(ingredientWithFoodAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    const result = await updateIngredientService(
      ctx.db,
      ctx.usdaClient,
      input.id,
      input.data,
      ctx.actorContext,
    );
    const backgroundBatches = await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "ingredient", entityId: input.id },
      source: "ingredient.update",
    });
    const recipeBatches =
      await ctx.services.recipeCosting.recomputeForIngredient(input.id, {
        source: "ingredient.update",
        entity: { entityType: "ingredient", entityId: input.id },
      });
    return {
      ...result,
      sideEffects: {
        backgroundBatches: [...backgroundBatches, ...recipeBatches],
      },
    };
  });

const merge = protectedProcedure
  .input(ingredientMergeInput)
  .output(ingredientMergeOut)
  .mutation(async ({ ctx, input }) => {
    const { ingredient: merged, summary } = await mergeIngredients(
      ctx.db,
      ctx.usdaClient,
      input.target,
      input.aliases,
      {
        dryRun: input.dryRun,
      },
    );
    // The merge marked the absorbed recipes stale in-transaction; dispatch their
    // recompute OFF the request path (queue in prod, inline in dev) so a
    // heavily-used target can't overrun the Workers budget and sink the mutation.
    if (!input.dryRun) {
      const recipeBatches = await ctx.services.recipeCosting.dispatchRecompute(
        summary.affectedRecipeIds,
        {
          source: "ingredient.merge",
          entity: { entityType: "ingredient", entityId: merged.id },
        },
      );
      const backgroundBatches = await runMutationSideEffects(ctx.db, {
        action: "updated",
        entity: { entityType: "ingredient", entityId: merged.id },
        source: "ingredient.merge",
      });
      const deletedBatches = await runMutationSideEffectsForEntities(
        ctx.db,
        summary.deletedIds.map((id) => ({
          action: "deleted" as const,
          entity: { entityType: "ingredient" as const, entityId: id },
          source: "ingredient.merge",
        })),
      );
      return {
        ...merged,
        sideEffects: {
          backgroundBatches: [
            ...recipeBatches,
            ...backgroundBatches,
            ...deletedBatches,
          ],
        },
        mergeSummary: {
          aliasesAdded: summary.aliasesAdded,
          recipesMoved: summary.recipesMoved,
          productsMoved: summary.productsMoved,
          deletedIds: summary.deletedIds,
        },
      };
    }
    return {
      ...merged,
      sideEffects: { backgroundBatches: [] },
      mergeSummary: {
        aliasesAdded: summary.aliasesAdded,
        recipesMoved: summary.recipesMoved,
        productsMoved: summary.productsMoved,
        deletedIds: summary.deletedIds,
      },
    };
  });

// Read-only merge preview: per-candidate counts (recipe usages, linked products,
// aliases) + USDA-linkability, so the merge-confirmation picker can default the
// keeper to the best candidate and show what each row carries. No writes.
const mergeImpact = protectedProcedure
  .input(ingredientMergeImpactInput)
  .output(ingredientMergeImpactOut)
  .query(async ({ ctx, input }) => {
    return await mergeImpactForIngredients(ctx.db, input.ids);
  });

// The enrichment workbench worklist: recipe-used ingredients that aren't fully
// costable, with coverage + recommended fix computed server-side.
const enrichmentWorkbench = protectedProcedure
  .input(z.object({ recipeId: recipeId.optional() }).optional())
  .output(enrichmentRowsOut)
  .query(async ({ ctx, input }) => {
    return await enrichmentWorkbenchService(ctx.db, ctx.usdaClient, {
      recipeId: input?.recipeId,
    });
  });

// On-demand recipe usages for one ingredient. The workbench's expanded-row footer
// fetches this lazily so the worklist query itself stays lean — it no longer
// ships every usage's recipe body per row (see enrichmentWorkbenchIngredients).
const recipeUsages = protectedProcedure
  .input(ingredientIdInput)
  .output(ingredientRecipeUsagesOut)
  .query(async ({ ctx, input }) => {
    const usages = await getRecipeUsagesForIngredient(ctx.db, input.id);
    return usages.recipeUsages;
  });

// Bulk parser-triage: original `rawLine` + parsed modifier/amounts of every live
// recipe line linked to each ingredient, in one query. Powers the junk-ingredient
// sweep (instruction fragments / quantity stubs the importer mis-created as
// ingredients) without paging recipeUsages per id. Grouped by the MCP tool.
const rawLines = protectedProcedure
  .input(ingredientRawLinesInput)
  .output(ingredientRawLinesOut)
  .query(async ({ ctx, input }) => {
    return await getRawLinesForIngredients(ctx.db, input.ids);
  });

const getByName = protectedProcedure
  .input(ingredientNameFilterInput)
  .output(ingredientWithFoodOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getIngredientByName(ctx.db, ctx.usdaClient, input.nameFilter);
  });

// Batch name→match lookup in one query. The cookbook importer uses this to show
// the matched/new status for a whole book's ingredients at once, instead of one
// getByName per ingredient per recipe card (hundreds of round-trips).
const matchNames = protectedProcedure
  .input(ingredientNamesInput)
  .output(ingredientMatchesOut)
  .query(async ({ ctx, input }) => {
    return await getIngredientMatches(ctx.db, input.names);
  });

// Batch resolve-or-create in one round-trip: each name is matched to an existing
// standalone ingredient (case-insensitive on name/aliases) or created. Returns one
// entry per name with `matched`/`created` flags, so an agent can collapse the
// search_ingredients-then-create_ingredient loop (dozens of calls) into one.
const resolveOrCreate = protectedProcedure
  .input(ingredientResolvableNamesInput)
  .output(ingredientResolveOrCreateOut)
  .mutation(async ({ ctx, input }) => {
    const result = await resolveOrCreateIngredients(ctx.db, input.names);
    await runMutationSideEffectsForEntities(
      ctx.db,
      result
        .filter((ingredient) => ingredient.created)
        .map((ingredient) => ({
          action: "created" as const,
          entity: {
            entityType: "ingredient" as const,
            entityId: ingredient.id,
          },
          source: "ingredient.resolveOrCreate",
        })),
    );
    return result;
  });

// Batched id→ingredient lookup in one query (+ one cross-ingredient USDA enrich).
// The recipe list uses this to load every ingredient for its cost/calorie columns
// in a single round-trip instead of one getByID per ingredient (hundreds).
const getManyByIDs = protectedProcedure
  .input(ingredientIdsInput)
  // Lean output: products + food only (the consumer computes costs and reads no
  // recipe-usage data) — the full ingredient graph's per-usage recipe bodies were
  // a ~1s over-fetch on a recipe's ingredient set.
  .output(ingredientWithFoodLeanListOut)
  .query(async ({ ctx, input }) => {
    return await getIngredientsByIDs(ctx.db, ctx.usdaClient, input.ids);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<IngredientId>(
  async (services, ids) => {
    await deleteIngredients(services.db, ids, services.actorContext);
    return await runMutationSideEffectsForEntities(
      services.db,
      ids.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "ingredient" as const, entityId: id },
        source: "ingredient.delete",
      })),
    );
  },
  ingredientId,
);

export const ingredientRouter = createTRPCRouter({
  getByName,
  mergeImpact,
  enrichmentWorkbench,
  recipeUsages,
  rawLines,
  matchNames,
  resolveOrCreate,
  getByID,
  getManyByIDs,
  list,
  merge,
  create,
  update,
  delete: deleteItem,
});

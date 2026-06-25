/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { recipeUsageOut } from "@cubby/schemas/combo";
import { type IngredientId, ingredientId } from "@cubby/schemas/identifiers";
import {
  ingredientBase,
  ingredientFiltersSchema,
} from "@cubby/schemas/ingredient";
import { recomputeSummary } from "@cubby/schemas/recipe";
import { z } from "zod";
import {
  deleteIngredients,
  getIngredientMatches,
  getRecipeUsagesForIngredient,
  resolveOrCreateIngredients,
} from "~/server/repo/ingredient";
import {
  enrichmentRowOut,
  ingredientListItemOut,
  ingredientWithFoodLeanOut,
  ingredientWithFoodOut,
} from "~/server/services/ingredient.service";
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
  schemas: { output: ingredientListItemOut, filters: ingredientFiltersSchema },
  repository: {
    list: async (services, filters, sort, pagination) => {
      return await services.services.ingredient.ingredientList(
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
    createInput: ingredientBase,
    updateInput: ingredientBase.partial(),
    output: ingredientWithFoodOut,
    idSchema: ingredientId,
  },
  repository: {
    getByID: async (services, id: IngredientId) => {
      return await services.services.ingredient.getIngredientByID(id);
    },
    create: async (services, data) => {
      return await services.services.ingredient.createIngredient(
        data,
        services.actorContext,
      );
    },
    update: async (services, id: IngredientId, data) => {
      return await services.services.ingredient.updateIngredient(
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
  .input(z.object({ id: ingredientId, data: ingredientBase.partial() }))
  .output(ingredientWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    const result = await ctx.services.ingredient.updateIngredient(
      input.id,
      input.data,
      ctx.actorContext,
    );
    const recipesRecomputed =
      await ctx.services.recipeCosting.recomputeForIngredient(input.id);
    return {
      ...result,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated: 0 },
    };
  });

const merge = protectedProcedure
  .input(
    z.object({
      target: ingredientId,
      aliases: z.array(ingredientId).min(1),
    }),
  )
  .output(ingredientWithFoodOut.extend({ sideEffects: recomputeSummary }))
  .mutation(async ({ ctx, input }) => {
    const result = await ctx.services.ingredient.mergeIngredients(
      input.target,
      input.aliases,
    );
    // Post-merge the alias rows reference the target, so recomputing the target's
    // recipes covers every recipe that used a merged alias.
    const recipesRecomputed =
      await ctx.services.recipeCosting.recomputeForIngredient(input.target);
    return {
      ...result,
      sideEffects: { recipesRecomputed, inventoryValuationsUpdated: 0 },
    };
  });

// The enrichment workbench worklist: recipe-used ingredients that aren't fully
// costable, with coverage + recommended fix computed server-side.
const enrichmentWorkbench = protectedProcedure
  .output(z.array(enrichmentRowOut))
  .query(async ({ ctx }) => {
    return await ctx.services.ingredient.enrichmentWorkbench();
  });

// On-demand recipe usages for one ingredient. The workbench's expanded-row footer
// fetches this lazily so the worklist query itself stays lean — it no longer
// ships every usage's recipe body per row (see enrichmentWorkbenchIngredients).
const recipeUsages = protectedProcedure
  .input(z.object({ id: ingredientId }))
  .output(z.array(recipeUsageOut))
  .query(async ({ ctx, input }) => {
    const usages = await getRecipeUsagesForIngredient(ctx.db, input.id);
    return usages.recipeUsages;
  });

const getByName = protectedProcedure
  .input(
    z.object({
      nameFilter: z.string(),
    }),
  )
  .output(ingredientWithFoodOut.nullable())
  .query(async ({ ctx, input }) => {
    return await ctx.services.ingredient.getIngredientByName(input.nameFilter);
  });

// Batch name→match lookup in one query. The cookbook importer uses this to show
// the matched/new status for a whole book's ingredients at once, instead of one
// getByName per ingredient per recipe card (hundreds of round-trips).
const matchNames = protectedProcedure
  .input(z.object({ names: z.array(z.string()) }))
  .output(
    z.record(
      z.string(),
      z
        .object({
          id: z.string(),
          name: z.string(),
          aliases: z.array(z.string()),
        })
        .nullable(),
    ),
  )
  .query(async ({ ctx, input }) => {
    return await getIngredientMatches(ctx.db, input.names);
  });

// Batch resolve-or-create in one round-trip: each name is matched to an existing
// standalone ingredient (case-insensitive on name/aliases) or created. Returns one
// entry per name with `matched`/`created` flags, so an agent can collapse the
// search_ingredients-then-create_ingredient loop (dozens of calls) into one.
const resolveOrCreate = protectedProcedure
  .input(z.object({ names: z.array(z.string().min(1)) }))
  .output(
    z.array(
      z.object({
        name: z.string(),
        id: ingredientId,
        matched: z.boolean(),
        created: z.boolean(),
      }),
    ),
  )
  .mutation(async ({ ctx, input }) => {
    return await resolveOrCreateIngredients(ctx.db, input.names);
  });

// Batched id→ingredient lookup in one query (+ one cross-ingredient USDA enrich).
// The recipe list uses this to load every ingredient for its cost/calorie columns
// in a single round-trip instead of one getByID per ingredient (hundreds).
const getManyByIDs = protectedProcedure
  .input(z.object({ ids: z.array(ingredientId) }))
  // Lean output: products + food only (the consumer computes costs and reads no
  // recipe-usage data) — the full ingredient graph's per-usage recipe bodies were
  // a ~1s over-fetch on a recipe's ingredient set.
  .output(z.array(ingredientWithFoodLeanOut))
  .query(async ({ ctx, input }) => {
    return await ctx.services.ingredient.getIngredientsByIDs(input.ids);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<IngredientId>(
  async (services, ids) => {
    await deleteIngredients(services.db, ids, services.actorContext);
  },
  ingredientId,
);

export const ingredientRouter = createTRPCRouter({
  getByName,
  enrichmentWorkbench,
  recipeUsages,
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

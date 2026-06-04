/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { type IngredientId, ingredientId } from "@cubby/schemas/identifiers";
import { ingredientBase } from "@cubby/schemas/ingredient";
import { z } from "zod";
import {
  deleteIngredients,
  getIngredientMatches,
  mergeIngredients,
} from "~/server/repo/ingredient";
import { ingredientWithFoodOut } from "~/server/services/ingredient.service";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Define filters schema for ingredients
const ingredientFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  missingProductsOnly: z.boolean().optional().default(false),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: ingredientBase,
    updateInput: ingredientBase.partial(),
    output: ingredientWithFoodOut,
    filters: ingredientFiltersSchema,
    idSchema: ingredientId,
  },
  repository: {
    getByID: async (services, id: IngredientId) => {
      return await services.services.ingredient.getIngredientByID(id);
    },
    list: async (services, filters, sort, pagination) => {
      return await services.services.ingredient.ingredientList(
        filters.nameFilter,
        sort,
        pagination,
        filters.missingProductsOnly,
      );
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
  entityName: "ingredient",
});

const merge = protectedProcedure
  .input(
    z.object({
      target: ingredientId,
      aliases: z.array(ingredientId).min(1),
    }),
  )
  .output(ingredientWithFoodOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    return await ctx.services.ingredient.getIngredientByID(input.target);
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

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<IngredientId>(
  async (services, ids) => {
    await deleteIngredients(services.db, ids, services.actorContext);
  },
  ingredientId,
);

export const ingredientRouter = createTRPCRouter({
  getByName,
  matchNames,
  getByID,
  list,
  merge,
  create,
  update,
  delete: deleteItem,
});

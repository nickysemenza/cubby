/**
 * Ingredient Router - Uses service layer
 *
 * Ingredients integrate with the USDA external API for nutrition data enrichment,
 * so CRUD operations go through the ingredient service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { ingredientWithFoodOut } from "~/server/services/ingredient.service";
import { mergeIngredients } from "~/server/repo/ingredient";
import { ingredientBase } from "~/schemas/ingredient";
import { createEntityCrudProcedures } from "../crud-factory";
import { ingredientId, type IngredientId } from "~/schemas/identifiers";

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
      return await services.services.ingredient.getIngredientByID(
        id,
        services.organizationId,
      );
    },
    list: async (services, filters, sort, pagination) => {
      return await services.services.ingredient.ingredientList(
        services.organizationId,
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
    return await ctx.services.ingredient.getIngredientByID(
      input.target,
      ctx.organizationId,
    );
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

export const ingredientRouter = createTRPCRouter({
  getByName,
  getByID,
  list,
  merge,
  create,
  update,
});

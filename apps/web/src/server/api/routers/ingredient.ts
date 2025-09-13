import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { ingredientWithFoodOut } from "~/server/services/ingredient.service";
import { mergeIngredients } from "~/server/repo/ingredient";
import { ingredientBase } from "~/schemas/ingredient";
import { createEntityCrudProcedures } from "../crud-factory";

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
  },
  repository: {
    getByID: async (services, id) => {
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
      return await services.services.ingredient.createIngredient(data);
    },
    update: async (services, id, data) => {
      return await services.services.ingredient.updateIngredient(id, data);
    },
  },
});

const merge = publicProcedure
  .input(
    z.object({
      target: z.uuid(),
      aliases: z.array(z.uuid()).min(1),
    }),
  )
  .output(ingredientWithFoodOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    return await ctx.services.ingredient.getIngredientByID(input.target);
  });

const getByName = publicProcedure
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

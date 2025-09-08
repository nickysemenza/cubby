import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import {
  getIngredientByID,
  mergeIngredients,
  ingredientList,
  getIngredientByName,
  createIngredient,
  updateIngredient,
} from "~/server/repo/ingredient";
import { ingredientWithRecipesAndProductOut } from "~/schemas/combo";
import { ingredientBase } from "~/schemas/ingredient";
import { createEntityCrudProcedures } from "../crud-factory";

// Define filters schema for ingredients
const ingredientFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  missingProductsOnly: z.boolean().optional().prefault(false),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: ingredientBase,
    updateInput: ingredientBase.partial(),
    output: ingredientWithRecipesAndProductOut,
    filters: ingredientFiltersSchema,
  },
  repository: {
    getByID: getIngredientByID,
    list: async (db, filters, sort, pagination) => {
      return await ingredientList(
        db,
        filters.nameFilter,
        sort,
        pagination,
        filters.missingProductsOnly,
      );
    },
    create: createIngredient,
    update: updateIngredient,
  },
});

const merge = publicProcedure
  .input(
    z.object({
      target: z.uuid(),
      aliases: z.array(z.uuid()).min(1),
    }),
  )
  .output(ingredientWithRecipesAndProductOut)
  .mutation(async ({ ctx, input }) => {
    await mergeIngredients(ctx.db, input.target, input.aliases);
    return await getIngredientByID(ctx.db, input.target);
  });

const getByName = publicProcedure
  .input(
    z.object({
      nameFilter: z.string(),
    }),
  )
  .output(ingredientWithRecipesAndProductOut.nullable())
  .query(
    async ({ ctx, input }) =>
      await getIngredientByName(ctx.db, input.nameFilter),
  );

export const ingredientRouter = createTRPCRouter({
  getByName,
  getByID,
  list,
  merge,
  create,
  update,
});

import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure, systemProcedure } from "../trpc";

import { z } from "zod";
import { compactRecipeSchema } from "~/codec/codec";
import { seedRealRecipes } from "~/testdata/seed";
import { scrapeToCompact } from "./scraper";
import {
  recipeOut,
  recipeCreateInput,
  recipeUpdateInput,
} from "~/schemas/recipe";
import {
  createRecipe,
  getRecipeByID,
  insertCompactRecipe,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import { createEntityCrudProcedures } from "../crud-factory";
import { recipeId, type RecipeId } from "~/schemas/identifiers";

// Define filters schema for recipes
const recipeFiltersSchema = z.object({
  nameFilter: z.string().optional(),
});

// Create standardized CRUD procedures using factory
const { getByID, list, create, update } = createEntityCrudProcedures({
  schemas: {
    createInput: recipeCreateInput,
    updateInput: recipeUpdateInput.shape.data,
    output: recipeOut,
    filters: recipeFiltersSchema,
    idSchema: recipeId,
  },
  repository: {
    getByID: async (services, id: RecipeId) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      const res = await getRecipeByID(
        id,
        services.db,
        services.organizationId!,
      );
      if (res === null) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Recipe not found" });
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await recipeList(
        services.db,
        services.organizationId!,
        filters.nameFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await createRecipe(data, services.db, services.organizationId!);
    },
    update: async (services, id: RecipeId, data) => {
      // organizationId guaranteed non-null by requireOrganization middleware
      return await updateRecipe(
        id,
        data,
        services.db,
        services.organizationId!,
      );
    },
  },
});

const seed = systemProcedure.mutation(
  async ({ ctx }) => await seedRealRecipes(ctx.db, ctx.organizationId),
);
const scrape = protectedProcedure
  .input(z.url())
  .output(compactRecipeSchema)
  .mutation(async ({ input }) => await scrapeToCompact(input));
const insertCompact = protectedProcedure
  .input(compactRecipeSchema)
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    return await insertCompactRecipe(input, ctx.db, ctx.organizationId);
  });

export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  getByID,
  list,
  create,
  update,
});

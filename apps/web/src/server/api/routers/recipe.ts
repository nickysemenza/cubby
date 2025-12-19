/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  createTRPCRouter,
  protectedProcedure,
  systemProcedure,
  createAppError,
} from "../trpc";

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
      const res = await getRecipeByID(id, services.db, services.organizationId);
      if (res === null) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await recipeList(
        services.db,
        services.organizationId,
        filters.nameFilter,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      return await createRecipe(data, services.db, services.actorContext);
    },
    update: async (services, id: RecipeId, data) => {
      return await updateRecipe(id, data, services.db, services.actorContext);
    },
  },
  entityName: "recipe",
});

const seed = systemProcedure.mutation(async ({ ctx }) => {
  return await seedRealRecipes(ctx.db, ctx.actorContext);
});
const scrape = protectedProcedure
  .input(z.url())
  .output(compactRecipeSchema)
  .mutation(async ({ input }) => await scrapeToCompact(input));
const insertCompact = protectedProcedure
  .input(compactRecipeSchema)
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    return await insertCompactRecipe(input, ctx.db, ctx.actorContext);
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

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
  getIngredientCooccurrence,
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
      const res = await getRecipeByID(services.db, id, services.organizationId);
      if (res === null) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await recipeList(
        services.db,
        services.organizationId,
        filters,
        sort,
        pagination,
      );
    },
    create: async (services, data) => {
      return await createRecipe(services.db, data, services.actorContext);
    },
    update: async (services, id: RecipeId, data) => {
      return await updateRecipe(services.db, id, data, services.actorContext);
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

// Import co-occurrence schema and types
import {
  ingredientCooccurrenceSchema,
  type IngredientCooccurrence,
} from "~/schemas/ingredient-cooccurrence";

const getIngredientCooccurrenceEndpoint = protectedProcedure
  .input(z.object({ minEdgeWeight: z.number().min(1).default(2) }).optional())
  .output(ingredientCooccurrenceSchema)
  .query(async ({ ctx, input }): Promise<IngredientCooccurrence> => {
    return await getIngredientCooccurrence(
      ctx.db,
      ctx.organizationId,
      input?.minEdgeWeight ?? 2,
    );
  });

export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  getByID,
  list,
  create,
  update,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
});

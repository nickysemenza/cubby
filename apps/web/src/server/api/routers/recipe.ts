/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { z } from "zod";
import { compactRecipeSchema } from "~/codec/codec";
import { type RecipeId, recipeId } from "~/schemas/identifiers";
import {
  recipeCreateInput,
  recipeOut,
  recipeUpdateInput,
} from "~/schemas/recipe";
import {
  createRecipe,
  getAllTags,
  getIngredientCooccurrence,
  getRecipeByID,
  getRecipeByShortcode,
  insertCompactRecipe,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import { seedRealRecipes } from "~/testdata/seed";
import { createEntityCrudProcedures } from "../crud-factory";
import {
  createAppError,
  createTRPCRouter,
  protectedProcedure,
  systemProcedure,
} from "../trpc";
import { scrapeToCompact } from "./scraper";

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
      const res = await getRecipeByID(services.db, id);
      if (res === null) {
        throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
      }
      return res;
    },
    list: async (services, filters, sort, pagination) => {
      return await recipeList(services.db, filters, sort, pagination);
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
  type IngredientCooccurrence,
  ingredientCooccurrenceSchema,
} from "~/schemas/ingredient-cooccurrence";

const getIngredientCooccurrenceEndpoint = protectedProcedure
  .input(z.object({ minEdgeWeight: z.number().min(1).default(2) }).optional())
  .output(ingredientCooccurrenceSchema)
  .query(async ({ ctx, input }): Promise<IngredientCooccurrence> => {
    return await getIngredientCooccurrence(ctx.db, input?.minEdgeWeight ?? 2);
  });

const getAllTagsEndpoint = protectedProcedure
  .output(z.array(z.string()))
  .query(async ({ ctx }) => {
    return await getAllTags(ctx.db);
  });

// Get recipe by shortcode (e.g., R-X7K9)
const getByShortcode = protectedProcedure
  .input(z.object({ shortcode: z.string() }))
  .output(recipeOut.nullable())
  .query(async ({ ctx, input }) => {
    return await getRecipeByShortcode(ctx.db, input.shortcode);
  });

export const recipeRouter = createTRPCRouter({
  insertCompact,
  scrape,
  seed,
  getByID,
  getByShortcode,
  list,
  create,
  update,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getAllTags: getAllTagsEndpoint,
});

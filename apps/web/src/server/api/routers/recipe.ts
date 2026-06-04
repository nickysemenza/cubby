/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { compactRecipeSchema } from "@cubby/schemas/codec";
import { cookbookRecipeSchema } from "@cubby/schemas/cookbook";
import { type RecipeId, recipeId } from "@cubby/schemas/identifiers";
import {
  type IngredientCooccurrence,
  ingredientCooccurrenceSchema,
} from "@cubby/schemas/ingredient-cooccurrence";
import {
  recipeCreateInput,
  recipeOut,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  createRecipe,
  deleteRecipes,
  getAllTags,
  getCookbookRecipeTitles,
  getIngredientCooccurrence,
  getRecipeByID,
  getRecipeByShortcode,
  insertCompactRecipe,
  insertCookbookRecipe,
  recipeList,
  updateRecipe,
} from "~/server/repo/recipe";
import { extractCookbookChunk } from "~/server/utils/cookbook-llm";
import { scrapeToCompact } from "~/server/utils/scraper";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, systemProcedure } from "../trpc";

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
  // Dynamic import to avoid bundling test data in production
  const { seedRealRecipes } = await import("~/testdata/seed");
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
// Import one recipe extracted from an EPUB cookbook, scoped to its book so
// re-imports upsert by (book, title) and stamp "Book" provenance.
const insertCookbook = protectedProcedure
  .input(z.object({ recipe: cookbookRecipeSchema, book: z.string().min(1) }))
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    return await insertCookbookRecipe(input.recipe, input.book, ctx.db, {
      ...ctx.actorContext,
      source: "epub_import",
    });
  });
// Titles already imported from a given book, so the import preview can flag
// recipes a re-import would update.
const getCookbookTitles = protectedProcedure
  .input(z.object({ book: z.string().min(1) }))
  .output(z.array(z.string()))
  .query(async ({ ctx, input }) => {
    return await getCookbookRecipeTitles(ctx.db, input.book);
  });

// LLM passthrough for the in-browser EPUB extractor: the client builds each
// chunk's request in WASM (`recipebridge.chunk_epub`) and sends it here so the
// gateway key stays server-side. Returns the raw forced-tool `input`
// (`{ recipes: [...] }`) for the WASM `assemble_recipes` to parse — no recipe
// logic lives here. One short, network-bound request per chunk.
const extractCookbookChunkProc = protectedProcedure
  .input(
    z.object({
      system: z.string(),
      user: z.string(),
      toolName: z.string(),
      // The forced tool's JSON Schema, built in WASM and forwarded verbatim.
      toolSchema: z.record(z.string(), z.unknown()),
    }),
  )
  .mutation(async ({ input }) => {
    return await extractCookbookChunk({
      system: input.system,
      user: input.user,
      toolName: input.toolName,
      toolSchema: input.toolSchema,
    });
  });

// Import co-occurrence schema and types

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

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<RecipeId>(async (services, ids) => {
  await deleteRecipes(services.db, ids, services.actorContext);
}, recipeId);

export const recipeRouter = createTRPCRouter({
  insertCompact,
  insertCookbook,
  getCookbookTitles,
  extractCookbookChunk: extractCookbookChunkProc,
  scrape,
  seed,
  getByID,
  getByShortcode,
  list,
  create,
  update,
  delete: deleteItem,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getAllTags: getAllTagsEndpoint,
});

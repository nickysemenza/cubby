/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import { compactRecipeSchema } from "@cubby/schemas/codec";
import {
  cookbookRecipeSchema,
  cookbookRecipesSchema,
} from "@cubby/schemas/cookbook";
import {
  cookbookId,
  type RecipeId,
  recipeId,
  unsafeCookbookId,
} from "@cubby/schemas/identifiers";
import {
  type IngredientCooccurrence,
  ingredientCooccurrenceSchema,
} from "@cubby/schemas/ingredient-cooccurrence";
import {
  cookbookSummary,
  recipeCreateInput,
  recipeOut,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import { z } from "zod";
import { createAppError } from "~/server/errors/app-error";
import {
  getCookbookByName,
  getCookbookSource,
  listCookbooks,
  reprocessCookbook,
  upsertCookbook,
} from "~/server/repo/cookbook";
import {
  createRecipe,
  deleteRecipes,
  deleteRecipesByCookbook,
  getAllTags,
  getCookbookRecipeTitles,
  getIngredientCooccurrence,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipesByIDs,
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
import { createTRPCRouter, protectedProcedure } from "../trpc";

// Define filters schema for recipes
const recipeFiltersSchema = z.object({
  nameFilter: z.string().optional(),
  // Scope the list to one cookbook by FK id (cookbook detail page).
  cookbookId: cookbookId.optional(),
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
      const created = await createRecipe(
        services.db,
        data,
        services.actorContext,
      );
      // Recompute its totals now (instant freshness) + null any parents.
      await services.services.recipeCosting.recompute([created.id as RecipeId]);
      return created;
    },
    update: async (services, id: RecipeId, data) => {
      const updated = await updateRecipe(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await services.services.recipeCosting.recompute([id]);
      return updated;
    },
  },
  entityName: "recipe",
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
// Create/refresh a cookbook from a full EPUB extraction. Called once at the start
// of an import (before any recipe insert) so the FK target exists and the raw JSON
// + OPF metadata are stored for reprocessing. Returns the cookbook id the
// per-recipe inserts attach to.
const upsertCookbookEndpoint = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1),
      rawJson: cookbookRecipesSchema,
      author: z.array(z.string()).optional(),
      subjects: z.array(z.string()).optional(),
      sourceLabel: z.string(),
      coverImageId: z.uuid().optional(),
    }),
  )
  .output(z.object({ id: cookbookId }))
  .mutation(async ({ ctx, input }) => {
    return await upsertCookbook(ctx.db, input, {
      ...ctx.actorContext,
      source: "epub_import",
    });
  });
// Hand back a cookbook's stored extraction so the importer can re-open it for
// selective re-import (no LLM, no EPUB). See the import flow's "from stored source".
const getCookbookSourceEndpoint = protectedProcedure
  .input(z.object({ cookbookId }))
  .output(
    z.object({
      id: cookbookId,
      name: z.string(),
      recipes: cookbookRecipesSchema,
    }),
  )
  .query(async ({ ctx, input }) => {
    return await getCookbookSource(ctx.db, input.cookbookId);
  });
// Import one recipe extracted from an EPUB cookbook, linked to a cookbook created
// up-front via `upsertCookbook`. Re-imports upsert by (cookbookId, title) and
// stamp "Book" provenance + the FK.
const insertCookbook = protectedProcedure
  .input(
    z.object({
      recipe: cookbookRecipeSchema,
      cookbookId,
      book: z.string().min(1),
    }),
  )
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    return await insertCookbookRecipe(
      input.recipe,
      { id: input.cookbookId, name: input.book },
      ctx.db,
      { ...ctx.actorContext, source: "epub_import" },
    );
  });
// Titles already imported from a given book, so the import preview can flag
// recipes a re-import would update. Empty when the cookbook doesn't exist yet.
const getCookbookTitles = protectedProcedure
  .input(z.object({ book: z.string().min(1) }))
  .output(z.array(z.string()))
  .query(async ({ ctx, input }) => {
    const cb = await getCookbookByName(ctx.db, input.book);
    if (!cb) return [];
    return await getCookbookRecipeTitles(ctx.db, unsafeCookbookId(cb.id));
  });

// Distinct cookbooks with recipe counts, for the browse-by-source index.
const listCookbooksEndpoint = protectedProcedure
  .output(z.array(cookbookSummary))
  .query(async ({ ctx }) => {
    return await listCookbooks(ctx.db);
  });

// Bulk-delete every recipe linked to one cookbook (cascades to sections,
// ingredients, and images via the shared deleteRecipes path).
const deleteByCookbook = protectedProcedure
  .input(z.object({ cookbookId }))
  .output(z.object({ deleted: z.number().int().nonnegative() }))
  .mutation(async ({ ctx, input }) => {
    return await deleteRecipesByCookbook(
      ctx.db,
      input.cookbookId,
      ctx.actorContext,
    );
  });

// Re-derive a cookbook's recipes from its stored raw JSON (re-runs the WASM
// ingredient parser, no LLM). Returns how many were reprocessed and any extracted
// recipes that were never imported.
const reprocessCookbookEndpoint = protectedProcedure
  .input(z.object({ cookbookId }))
  .output(
    z.object({
      reprocessed: z.number().int().nonnegative(),
      importableExtras: z.array(z.string()),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return await reprocessCookbook(ctx.db, input.cookbookId, ctx.actorContext);
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

// Batched fetch by id — mirrors ingredient.getManyByIDs. Used by client-side
// cost rollup to resolve sub-recipes (recipe-as-ingredient) without an N+1
// fan-out of getByID calls. Missing/deleted ids are omitted from the result.
const getManyByIDs = protectedProcedure
  .input(z.object({ ids: z.array(recipeId) }))
  .output(z.array(recipeOut))
  .query(async ({ ctx, input }) => {
    return await getRecipesByIDs(ctx.db, input.ids);
  });

// Delete procedure using standalone factory
const deleteItem = createDeleteProcedure<RecipeId>(async (services, ids) => {
  await deleteRecipes(services.db, ids, services.actorContext);
}, recipeId);

// Recompute one batch of recipes whose persisted totals are stale
// (totalsComputedAt IS NULL). Driven by the client while the app is open;
// returns how many remain so the caller can keep draining. A high `limit` also
// serves as a one-shot backfill (new rows start stale).
const recomputeStale = protectedProcedure
  .input(z.object({ limit: z.number().int().positive().max(500).default(25) }))
  .output(
    z.object({
      processed: z.number().int(),
      remaining: z.number().int(),
    }),
  )
  .mutation(async ({ ctx, input }) => {
    return await ctx.services.recipeCosting.drainStale(input.limit);
  });

// One-shot backfill: recompute every recipe's totals regardless of stale state.
// Admin/recovery (e.g. after the USDA backend was down during a drain).
const recomputeAll = protectedProcedure
  .output(z.object({ processed: z.number().int() }))
  .mutation(async ({ ctx }) => {
    return await ctx.services.recipeCosting.recomputeAll();
  });

export const recipeRouter = createTRPCRouter({
  insertCompact,
  upsertCookbook: upsertCookbookEndpoint,
  getCookbookSource: getCookbookSourceEndpoint,
  insertCookbook,
  getCookbookTitles,
  listCookbooks: listCookbooksEndpoint,
  deleteByCookbook,
  reprocessCookbook: reprocessCookbookEndpoint,
  extractCookbookChunk: extractCookbookChunkProc,
  scrape,
  getByID,
  getByShortcode,
  getManyByIDs,
  list,
  create,
  update,
  delete: deleteItem,
  recomputeStale,
  recomputeAll,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getAllTags: getAllTagsEndpoint,
});

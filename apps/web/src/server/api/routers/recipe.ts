/**
 * Recipe Router - Direct repo access
 *
 * Recipes do not require external API enrichment (e.g., USDA),
 * so they call repo functions directly without a service layer.
 * See CLAUDE.md "Service Layer Architecture" for details.
 */

import {
  cookbookId,
  type RecipeId,
  recipeId,
} from "@cubby/schemas/identifiers";
import {
  importRecipeSchema,
  importRecipesSchema,
} from "@cubby/schemas/import-recipe";
import {
  type IngredientCooccurrence,
  ingredientCooccurrenceSchema,
} from "@cubby/schemas/ingredient-cooccurrence";
import {
  cookbookSummary,
  recipeCostingExplain,
  recipeCreateInput,
  recipeOut,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import { z } from "zod";
import {
  importRecipeSignature,
  recipeOutSignature,
} from "~/lib/recipe-signature";
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
  getCookbookRecipesForDiff,
  getIngredientCooccurrence,
  getNotionRecipePageIds,
  getNotionRecipesForDiff,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipesByIDs,
  recipeList,
  updateRecipe,
  upsertCookbookRecipeFromCookbook,
  upsertImportRecipe,
  upsertNotionRecipeFromImport,
} from "~/server/repo/recipe";
import { extractCookbookChunk } from "~/server/utils/cookbook-llm";
import {
  lintImportRecipe,
  notionPageToImportRecipe,
} from "~/server/utils/notion-recipe";
import {
  htmlToImportRecipe,
  scrapeToImportRecipe,
} from "~/server/utils/scraper";
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
  .output(importRecipeSchema)
  .mutation(async ({ input }) => await scrapeToImportRecipe(input));
// Parse-only fallback for when a URL scrape is blocked (anti-bot, auth wall,
// JS-rendered): the user pastes the page HTML and we run the same parser.
const parseHtml = protectedProcedure
  .input(z.object({ html: z.string().min(1), url: z.url() }))
  .output(importRecipeSchema)
  .mutation(({ input }) => htmlToImportRecipe(input.html, input.url));
const insertImport = protectedProcedure
  .input(importRecipeSchema)
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    // TODO: enqueue imported recipe ids for async Cloudflare Queue recompute
    // instead of blocking per-recipe import requests.
    return await upsertImportRecipe(input, ctx.db, ctx.actorContext);
  });
// Create/refresh a cookbook from a full EPUB extraction. Called once at the start
// of an import (before any recipe insert) so the FK target exists and the raw JSON
// + OPF metadata are stored for reprocessing. Returns the cookbook id the
// per-recipe inserts attach to.
const upsertCookbookEndpoint = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1),
      rawJson: importRecipesSchema,
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
      recipes: importRecipesSchema,
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
      recipe: importRecipeSchema,
      cookbookId,
      book: z.string().min(1),
    }),
  )
  .output(z.object({ id: z.uuid() }))
  .mutation(async ({ ctx, input }) => {
    // TODO: enqueue cookbook import recipe ids for batched Cloudflare Queue
    // recompute instead of blocking each EPUB recipe insert.
    return await upsertCookbookRecipeFromCookbook(
      input.recipe,
      { id: input.cookbookId, name: input.book },
      ctx.db,
      { ...ctx.actorContext, source: "epub_import" },
    );
  });
// Recipes already imported from a given book, each with its id (for an in-app
// link) and a content signature (so the preview shows "no changes" vs "will
// update" per title). Empty when the cookbook doesn't exist yet.
const getCookbookDiff = protectedProcedure
  .input(z.object({ book: z.string().min(1) }))
  .output(
    z.array(z.object({ title: z.string(), id: z.uuid(), sig: z.string() })),
  )
  .query(async ({ ctx, input }) => {
    const cb = await getCookbookByName(ctx.db, input.book);
    if (!cb) return [];
    return await getCookbookRecipesForDiff(ctx.db, cb.id);
  });

// --- Notion recipe sync ---------------------------------------------------
// Stable, deterministic import from the Notion "Recipes" database. Preview parses
// every row server-side (no writes), diffs against already-imported page ids, and
// lints each for importability; the per-recipe commit upserts keyed on page id.
const notionPreviewItem = z.object({
  pageId: z.string(),
  name: z.string(),
  notionUrl: z.string(),
  status: z.enum(["new", "unchanged", "will-update", "needs-formatting"]),
  // The existing Cubby recipe id when already imported — drives the in-app link.
  existingId: z.string().nullable(),
  reasons: z.array(z.string()),
  // The mapped recipe in the shared cookbook shape, so the Notion and EPUB
  // previews render with the exact same card.
  recipe: importRecipeSchema,
});

// Notion page ids come dashed from the API but are stored dashless-tolerant;
// compare on the dashless form so a format difference never desyncs the diff.
const normalizeNotionId = (id: string): string => id.replace(/-/g, "");

const previewNotionSync = protectedProcedure
  .output(z.array(notionPreviewItem))
  .query(async ({ ctx }) => {
    const client = ctx.notionClient;
    if (!client) return [];
    const rows = await client.queryRecipes();
    // Existing Notion recipes keyed by page id, with a content signature so we
    // can distinguish "no changes" from "will update".
    const existing = new Map(
      (await getNotionRecipesForDiff(ctx.db)).map((e) => [
        normalizeNotionId(e.pageId),
        { id: e.id, sig: recipeOutSignature(e.recipe) },
      ]),
    );
    return await Promise.all(
      rows.map(async (row) => {
        const blocks = await client.getPageContent(row.id);
        const recipe = notionPageToImportRecipe(row, blocks);
        const { status: lintStatus, reasons } = lintImportRecipe(recipe);
        const prior = existing.get(normalizeNotionId(row.id));
        const status =
          lintStatus === "needs-formatting"
            ? ("needs-formatting" as const)
            : !prior
              ? ("new" as const)
              : importRecipeSignature(recipe, row.tags) === prior.sig
                ? ("unchanged" as const)
                : ("will-update" as const);
        return {
          pageId: row.id,
          name: row.name,
          notionUrl: row.notionUrl,
          status,
          existingId: prior?.id ?? null,
          reasons,
          recipe,
        };
      }),
    );
  });

const importNotionRecipe = protectedProcedure
  .input(z.object({ pageId: z.string() }))
  .output(z.object({ id: z.uuid(), status: z.enum(["created", "updated"]) }))
  .mutation(async ({ ctx, input }) => {
    const client = ctx.notionClient;
    if (!client) {
      throw createAppError("CONSTRAINT_VIOLATION", "Notion is not configured.");
    }
    const row = (await client.queryRecipes()).find(
      (r) => r.id === input.pageId,
    );
    if (!row) {
      throw createAppError(
        "RECIPE_NOT_FOUND",
        "That page isn't in the Notion Recipes database.",
      );
    }
    const blocks = await client.getPageContent(input.pageId);
    const recipe = notionPageToImportRecipe(row, blocks);
    const { status, reasons } = lintImportRecipe(recipe);
    if (status === "needs-formatting") {
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Recipe isn't import-ready: ${reasons.join(" ")}`,
      );
    }
    const existed = (await getNotionRecipePageIds(ctx.db)).some(
      (id) => normalizeNotionId(id) === normalizeNotionId(input.pageId),
    );
    const { id } = await upsertNotionRecipeFromImport(
      recipe,
      input.pageId,
      row.tags,
      ctx.db,
      ctx.actorContext,
    );
    await ctx.services.recipeCosting.recompute([id as RecipeId]);
    return { id, status: existed ? "updated" : "created" };
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

// Full costing explanation: persisted totals state vs a fresh compute with
// per-row diagnostics (usage classification, fired consumption rule, exact
// per-measure errors, unit-graph conversion paths), named USDA misses, and
// drift. Read-only — never stamps; consumed by the debug card + MCP tool.
const explainCosting = protectedProcedure
  .input(z.object({ id: recipeId }))
  .output(recipeCostingExplain)
  .query(async ({ ctx, input }) => {
    return await ctx.services.recipeCosting.explainRecipe(input.id);
  });

export const recipeRouter = createTRPCRouter({
  insertImport,
  upsertCookbook: upsertCookbookEndpoint,
  getCookbookSource: getCookbookSourceEndpoint,
  insertCookbook,
  getCookbookDiff,
  previewNotionSync,
  importNotionRecipe,
  listCookbooks: listCookbooksEndpoint,
  deleteByCookbook,
  reprocessCookbook: reprocessCookbookEndpoint,
  extractCookbookChunk: extractCookbookChunkProc,
  scrape,
  parseHtml,
  getByID,
  getByShortcode,
  getManyByIDs,
  list,
  create,
  update,
  delete: deleteItem,
  recomputeStale,
  recomputeAll,
  explainCosting,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getAllTags: getAllTagsEndpoint,
});

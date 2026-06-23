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
  type IngredientUsage,
  ingredientUsageSchema,
} from "@cubby/schemas/ingredient-usage";
import {
  cookbookSummary,
  recipeCostingExplain,
  recipeCreateInput,
  recipeFiltersSchema,
  recipeOut,
  recipeUpdateInput,
} from "@cubby/schemas/recipe";
import {
  type RecipeDependencyGraph,
  recipeDependencyGraphSchema,
} from "@cubby/schemas/recipe-dependency-graph";
import { z } from "zod";
import { type BulkProgressEvent, streamProgress } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";
import {
  importRecipeSignature,
  recipeOutSignature,
} from "~/lib/recipe-signature";
import { createAppError } from "~/server/errors/app-error";
import {
  getCookbookByName,
  getCookbookSource,
  listCookbooks,
  reprocessCookbookStream,
  upsertCookbook,
} from "~/server/repo/cookbook";
import {
  createRecipe,
  deleteRecipes,
  deleteRecipesByCookbook,
  getAllTags,
  getCookbookRecipesForDiff,
  getIngredientCooccurrence,
  getIngredientUsage,
  getNotionRecipePageIds,
  getNotionRecipesForDiff,
  getRecipeByID,
  getRecipeByShortcode,
  getRecipeDependencyGraph,
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

// Shared output for endpoints that just return a newly upserted recipe's id.
const recipeIdOut = z.object({ id: recipeId });

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
  .output(recipeIdOut)
  .mutation(async ({ ctx, input }) => {
    const result = await upsertImportRecipe(input, ctx.db, ctx.actorContext);
    // Recompute eagerly so totals are fresh on import (cheap — a fresh import's
    // ingredients are bare, so there's no USDA/price work yet). No drain anymore.
    await ctx.services.recipeCosting.recompute([result.id]);
    return result;
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
// Per-recipe outcome streamed back during a cookbook import, keyed by the client's
// `index` into its recipe list so each card maps to its result regardless of the
// topo order the recipes were sent in.
type ImportItemResult =
  | { index: number; ok: true; id: RecipeId }
  | { index: number; ok: false; error: string };
type ImportSummary = { succeeded: number; failed: number };

// Import an EPUB cookbook's selected recipes in ONE streamed request (replaces the
// old per-recipe `insertCookbook` client loop). The client sends only the selected
// recipe INDICES (topo-ordered so a referenced sub-recipe precedes its referrer) —
// the recipes themselves were already persisted in the cookbook's `rawJson` by the
// up-front `upsertCookbook`, so re-sending them would just bloat the request (a
// `.query`'s input rides in the URL → "input too big" past ~8KB). Yields per-recipe
// progress, then runs a single batched costing recompute at the end. Re-imports
// upsert by (cookbookId, title) and stamp "Book" provenance + the FK.
const importCookbookStream = protectedProcedure
  .input(
    z.object({
      cookbookId,
      indices: z.array(z.number().int().nonnegative()).min(1),
    }),
  )
  // A mutation (it writes): input rides in the POST body, and httpBatchStreamLink
  // streams the async-generator's yields incrementally (jsonl) just like a query.
  .mutation(async function* ({
    ctx,
    input,
  }): AsyncGenerator<BulkProgressEvent<ImportItemResult, ImportSummary>> {
    const actor = { ...ctx.actorContext, source: "epub_import" as const };
    // Recipes live in the cookbook's stored extraction; indices address it directly.
    const { name, recipes } = await getCookbookSource(ctx.db, input.cookbookId);
    const cookbookRef = { id: input.cookbookId, name };
    const insertedIds: RecipeId[] = [];
    let succeeded = 0;
    let failed = 0;
    const total = input.indices.length;
    yield { type: "progress", done: 0, total };
    // SEQUENTIAL + in received (topo) order: a forward cross-recipe reference
    // resolves only if its target was committed by an earlier iteration
    // (upsertCookbookRecipeFromCookbook re-reads the cookbook per upsert). Never
    // parallelize.
    for (let i = 0; i < input.indices.length; i++) {
      const index = input.indices[i]!;
      const recipe = recipes[index];
      try {
        if (!recipe) {
          throw new Error(
            `Recipe index ${index} is out of range for this cookbook`,
          );
        }
        const { id } = await upsertCookbookRecipeFromCookbook(
          recipe,
          cookbookRef,
          ctx.db,
          actor,
        );
        insertedIds.push(id);
        succeeded++;
        yield {
          type: "progress",
          done: i + 1,
          total,
          item: { index, ok: true, id },
        };
      } catch (error) {
        // Isolate: one malformed recipe can't sink the rest of the import.
        failed++;
        yield {
          type: "progress",
          done: i + 1,
          total,
          item: { index, ok: false, error: getErrorMessage(error) },
        };
      }
    }
    // ONE recompute for the whole import (was per-recipe). Costing never affects
    // reference resolution, so deferring to the end is safe.
    if (insertedIds.length > 0) {
      await ctx.services.recipeCosting.recompute(insertedIds);
    }
    yield { type: "done", result: { succeeded, failed } };
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

// Per-page outcome streamed back during a Notion import, keyed by the page id so
// each card maps to its result.
type NotionItemResult =
  | { pageId: string; ok: true; id: string; status: "created" | "updated" }
  | { pageId: string; ok: false; error: string };
type NotionSummary = { succeeded: number; failed: number };

// Import the selected Notion pages in ONE streamed request (replaces the old
// per-page importNotionRecipe client loop, which also re-queried the whole Notion
// DB on every iteration). Queries the Recipes DB once, upserts each selected page
// in its own tx (sequential, per-page error isolation), yields per-page progress,
// then runs a single batched costing recompute. Upserts are keyed on page id.
const importNotionSyncStream = protectedProcedure
  .input(z.object({ pageIds: z.array(z.string()).min(1) }))
  .mutation(async function* ({
    ctx,
    input,
  }): AsyncGenerator<BulkProgressEvent<NotionItemResult, NotionSummary>> {
    const client = ctx.notionClient;
    if (!client) {
      throw createAppError("CONSTRAINT_VIOLATION", "Notion is not configured.");
    }
    // Query the Recipes DB once + load existing page ids once (was N× per page).
    const rowById = new Map(
      (await client.queryRecipes()).map((r) => [r.id, r]),
    );
    const existing = new Set(
      (await getNotionRecipePageIds(ctx.db)).map(normalizeNotionId),
    );
    const insertedIds: RecipeId[] = [];
    let succeeded = 0;
    let failed = 0;
    const total = input.pageIds.length;
    yield { type: "progress", done: 0, total };
    for (let i = 0; i < input.pageIds.length; i++) {
      const pageId = input.pageIds[i]!;
      try {
        const row = rowById.get(pageId);
        if (!row) {
          throw new Error("That page isn't in the Notion Recipes database.");
        }
        const blocks = await client.getPageContent(pageId);
        const recipe = notionPageToImportRecipe(row, blocks);
        const { status: lintStatus, reasons } = lintImportRecipe(recipe);
        if (lintStatus === "needs-formatting") {
          throw new Error(`Recipe isn't import-ready: ${reasons.join(" ")}`);
        }
        const existed = existing.has(normalizeNotionId(pageId));
        const { id } = await upsertNotionRecipeFromImport(
          recipe,
          pageId,
          row.tags,
          ctx.db,
          ctx.actorContext,
        );
        insertedIds.push(id as RecipeId);
        succeeded++;
        yield {
          type: "progress",
          done: i + 1,
          total,
          item: {
            pageId,
            ok: true,
            id,
            status: existed ? "updated" : "created",
          },
        };
      } catch (error) {
        // Isolate: one malformed page can't sink the rest of the import.
        failed++;
        yield {
          type: "progress",
          done: i + 1,
          total,
          item: { pageId, ok: false, error: getErrorMessage(error) },
        };
      }
    }
    if (insertedIds.length > 0) {
      await ctx.services.recipeCosting.recompute(insertedIds);
    }
    yield { type: "done", result: { succeeded, failed } };
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

type ReprocessSummary = { reprocessed: number; importableExtras: string[] };

// Re-derive a cookbook's recipes from its stored raw JSON (re-runs the WASM
// ingredient parser, no LLM) in ONE streamed request. Yields per-recipe progress
// for a live bar, then runs a single batched recompute and yields the final
// summary (how many were reprocessed + any extracted recipes never imported).
const reprocessCookbookStreamEndpoint = protectedProcedure
  .input(z.object({ cookbookId }))
  // A mutation (it re-derives + writes recipes); streams progress like a query.
  .mutation(async function* ({
    ctx,
    input,
  }): AsyncGenerator<BulkProgressEvent<never, ReprocessSummary>> {
    const gen = reprocessCookbookStream(
      ctx.db,
      input.cookbookId,
      ctx.actorContext,
    );
    let next = await gen.next();
    while (!next.done) {
      yield {
        type: "progress",
        done: next.value.done,
        total: next.value.total,
      };
      next = await gen.next();
    }
    const { recipeIds, reprocessed, importableExtras } = next.value;
    await ctx.services.recipeCosting.recompute(recipeIds);
    yield { type: "done", result: { reprocessed, importableExtras } };
  });

// LLM passthrough for the in-browser EPUB extractor: the client builds each
// chunk's request in WASM (`recipebridge.chunk_epub`) and sends it here so the
// gateway key stays server-side. Returns the raw forced-tool `input`
// (`{ recipes: [...] }`) for the WASM driver (`extract_cookbook`) to parse — no
// recipe logic lives here. One short, network-bound request per chunk.
const extractCookbookChunkProc = protectedProcedure
  .input(
    z.object({
      system: z.string(),
      user: z.string(),
      toolName: z.string(),
      // The output JSON Schema, built in WASM and forwarded verbatim.
      toolSchema: z.record(z.string(), z.unknown()),
      // Escalate this chunk to the stronger fallback model. The browser sets
      // this only after the default model fails to return parseable output. The
      // model itself stays server-owned (a bool, not a model id) so a client
      // can't pick an arbitrary expensive model.
      escalate: z.boolean().optional(),
    }),
  )
  .mutation(async ({ input }) => {
    return await extractCookbookChunk({
      system: input.system,
      user: input.user,
      toolName: input.toolName,
      toolSchema: input.toolSchema,
      escalate: input.escalate ?? false,
    });
  });

// Import co-occurrence schema and types

const getIngredientCooccurrenceEndpoint = protectedProcedure
  .input(z.object({ minEdgeWeight: z.number().min(1).default(2) }).optional())
  .output(ingredientCooccurrenceSchema)
  .query(async ({ ctx, input }): Promise<IngredientCooccurrence> => {
    return await getIngredientCooccurrence(ctx.db, input?.minEdgeWeight ?? 2);
  });

const getDependencyGraphEndpoint = protectedProcedure
  .input(z.object({ cookbookId: cookbookId.optional() }).optional())
  .output(recipeDependencyGraphSchema)
  .query(async ({ ctx, input }): Promise<RecipeDependencyGraph> => {
    return await getRecipeDependencyGraph(ctx.db, input?.cookbookId);
  });

const getIngredientUsageEndpoint = protectedProcedure
  .input(z.object({ cookbookId: cookbookId.optional() }).optional())
  .output(ingredientUsageSchema)
  .query(async ({ ctx, input }): Promise<IngredientUsage> => {
    return await getIngredientUsage(ctx.db, input?.cookbookId);
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

// One-shot backfill: recompute every recipe's totals regardless of stale state.
// Admin/recovery (e.g. after the USDA backend was down during a drain). Kept
// non-streaming for the MCP tool, which wants the plain `{processed}` result.
const recomputeAll = protectedProcedure
  .output(z.object({ processed: z.number().int() }))
  .mutation(async ({ ctx }) => {
    return await ctx.services.recipeCosting.recomputeAll();
  });

// Streaming sibling for the maintenance UI button: same work, per-chunk progress.
const recomputeAllStream = protectedProcedure.mutation(async function* ({
  ctx,
}) {
  yield* streamProgress(
    ctx.services.recipeCosting.recomputeAllStream(),
    (r) => r,
  );
});

// Dry run for the force-recompute: how many recipes' totals would actually
// change vs persisted, without writing. Read-only but ~as costly as recomputeAll
// (full engine pass), so the UI triggers it on demand, not on load.
const dryRunRecomputeTotals = protectedProcedure
  .output(
    z.object({
      wouldChange: z.number().int(),
      total: z.number().int(),
    }),
  )
  .query(async ({ ctx }) => {
    return await ctx.services.recipeCosting.dryRunRecomputeTotals();
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
  importCookbookStream,
  getCookbookDiff,
  previewNotionSync,
  importNotionSyncStream,
  listCookbooks: listCookbooksEndpoint,
  deleteByCookbook,
  reprocessCookbook: reprocessCookbookStreamEndpoint,
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
  recomputeAll,
  recomputeAllStream,
  dryRunRecomputeTotals,
  explainCosting,
  getIngredientCooccurrence: getIngredientCooccurrenceEndpoint,
  getDependencyGraph: getDependencyGraphEndpoint,
  getIngredientUsage: getIngredientUsageEndpoint,
  getAllTags: getAllTagsEndpoint,
});

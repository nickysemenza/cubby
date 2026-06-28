/**
 * Recipe import / export procedures.
 *
 * URL scrape + HTML-paste parsing, single-import insert, EPUB cookbook
 * upsert / source / streamed import / diff / delete / reprocess / LLM chunk
 * passthrough, the cookbook index, and the Notion sync (preview + streamed
 * import). Split out of the recipe router god file; paths are re-composed flat
 * in `../recipe.ts`, so client procedure paths are unchanged.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";
import {
  chunkRequestInput,
  chunkResponseOut,
  cookbookDiffInput,
  cookbookDiffOut,
  cookbookIdInput,
  cookbookIdOut,
  cookbookSourceOut,
  cookbookSummariesOut,
  deleteCookbookRecipesOut,
  importCookbookStreamInput,
  importNotionSyncInput,
  importRecipeSchema,
  notionPreviewOut,
  parseRecipeHtmlInput,
  recipeImportIdOut,
  scrapeRecipeInput,
  upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import {
  type BulkProgressEvent,
  streamItems,
  streamProgress,
} from "~/lib/bulk-progress";
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
  type CookbookImportContext,
  deleteRecipesByCookbook,
  getCookbookRecipeIdsByTitle,
  getCookbookRecipesForDiff,
  getNotionRecipePageIds,
  getNotionRecipesForDiff,
  upsertCookbookRecipeFromCookbook,
  upsertImportRecipe,
  upsertNotionRecipeFromImport,
} from "~/server/repo/recipe";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { extractCookbookChunk } from "~/server/utils/cookbook-llm";
import {
  lintImportRecipe,
  notionPageToImportRecipe,
} from "~/server/utils/notion-recipe";
import {
  htmlToImportRecipe,
  scrapeToImportRecipe,
} from "~/server/utils/scraper";
import { protectedProcedure } from "../../trpc";

const scrape = protectedProcedure
  .input(scrapeRecipeInput)
  .output(importRecipeSchema)
  .mutation(async ({ input }) => await scrapeToImportRecipe(input));
// Parse-only fallback for when a URL scrape is blocked (anti-bot, auth wall,
// JS-rendered): the user pastes the page HTML and we run the same parser.
const parseHtml = protectedProcedure
  .input(parseRecipeHtmlInput)
  .output(importRecipeSchema)
  .mutation(({ input }) => htmlToImportRecipe(input.html, input.url));
const insertImport = protectedProcedure
  .input(importRecipeSchema)
  .output(recipeImportIdOut)
  .mutation(async ({ ctx, input }) => {
    const result = await upsertImportRecipe(input, ctx.db, ctx.actorContext);
    // Persist recompute work through the background dispatcher. In dev this
    // still drains inline, but the operation is visible on Background Jobs.
    await ctx.services.recipeCosting.dispatchRecompute([result.id], {
      source: "recipe.import",
      entity: { entityType: "recipe", entityId: result.id },
    });
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "recipe", entityId: result.id },
      source: "recipe.import",
    });
    return result;
  });
// Create/refresh a cookbook from a full EPUB extraction. Called once at the start
// of an import (before any recipe insert) so the FK target exists and the raw JSON
// + OPF metadata are stored for reprocessing. Returns the cookbook id the
// per-recipe inserts attach to.
const upsertCookbookEndpoint = protectedProcedure
  .input(upsertCookbookInput)
  .output(cookbookIdOut)
  .mutation(async ({ ctx, input }) => {
    return await upsertCookbook(ctx.db, input, {
      ...ctx.actorContext,
      source: "epub_import",
    });
  });
// Hand back a cookbook's stored extraction so the importer can re-open it for
// selective re-import (no LLM, no EPUB). See the import flow's "from stored source".
const getCookbookSourceEndpoint = protectedProcedure
  .input(cookbookIdInput)
  .output(cookbookSourceOut)
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
  .input(importCookbookStreamInput)
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
    // One shared context for the whole loop: a running (title → id) map (seeded
    // from the book, appended per commit) so forward refs resolve in-memory, and
    // an ingredient id cache so a repeated ingredient resolves once. Eliminates
    // the per-recipe title re-read + cross-recipe ingredient re-resolution.
    const importCtx: CookbookImportContext = {
      titleToId: await getCookbookRecipeIdsByTitle(ctx.db, input.cookbookId),
      ingredientIdByName: new Map(),
    };
    const insertedIds: RecipeId[] = [];
    // SEQUENTIAL + in received (topo) order: a forward cross-recipe reference
    // resolves only if its target was committed by an earlier iteration
    // (upsertCookbookRecipeFromCookbook re-reads the cookbook per upsert). Never
    // parallelize.
    yield* streamItems<number, ImportItemResult, ImportSummary>(
      input.indices,
      async (index): Promise<ImportItemResult> => {
        const recipe = recipes[index];
        if (!recipe) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Recipe index ${index} is out of range for this cookbook`,
          );
        }
        const { id } = await upsertCookbookRecipeFromCookbook(
          recipe,
          cookbookRef,
          ctx.db,
          actor,
          importCtx,
        );
        insertedIds.push(id);
        return { index, ok: true, id };
      },
      {
        // Isolate: one malformed recipe can't sink the rest of the import.
        onError: (index, _i, error) => ({
          index,
          ok: false,
          error: getErrorMessage(error),
        }),
        // ONE recompute for the whole import (was per-recipe). Costing never
        // affects reference resolution, so deferring to the end is safe.
        finalize: async (summary) => {
          if (insertedIds.length > 0) {
            await ctx.services.recipeCosting.dispatchRecompute(insertedIds, {
              source: "recipe.importCookbook",
            });
            await runMutationSideEffectsForEntities(
              ctx.db,
              insertedIds.map((id) => ({
                action: "updated" as const,
                entity: { entityType: "recipe" as const, entityId: id },
                source: "recipe.cookbookImport",
              })),
            );
          }
          return summary;
        },
      },
    );
  });
// Recipes already imported from a given book, each with its id (for an in-app
// link) and a content signature (so the preview shows "no changes" vs "will
// update" per title). Empty when the cookbook doesn't exist yet.
const getCookbookDiff = protectedProcedure
  .input(cookbookDiffInput)
  .output(cookbookDiffOut)
  .query(async ({ ctx, input }) => {
    const cb = await getCookbookByName(ctx.db, input.book);
    if (!cb) return [];
    return await getCookbookRecipesForDiff(ctx.db, cb.id);
  });

// --- Notion recipe sync ---------------------------------------------------
// Stable, deterministic import from the Notion "Recipes" database. Preview parses
// every row server-side (no writes), diffs against already-imported page ids, and
// lints each for importability; the per-recipe commit upserts keyed on page id.
// Notion page ids come dashed from the API but are stored dashless-tolerant;
// compare on the dashless form so a format difference never desyncs the diff.
const normalizeNotionId = (id: string): string => id.replace(/-/g, "");

const previewNotionSync = protectedProcedure
  .output(notionPreviewOut)
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
  .input(importNotionSyncInput)
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
    yield* streamItems<string, NotionItemResult, NotionSummary>(
      input.pageIds,
      async (pageId): Promise<NotionItemResult> => {
        const row = rowById.get(pageId);
        if (!row) {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            "That page isn't in the Notion Recipes database.",
          );
        }
        const blocks = await client.getPageContent(pageId);
        const recipe = notionPageToImportRecipe(row, blocks);
        const { status: lintStatus, reasons } = lintImportRecipe(recipe);
        if (lintStatus === "needs-formatting") {
          throw createAppError(
            "CONSTRAINT_VIOLATION",
            `Recipe isn't import-ready: ${reasons.join(" ")}`,
          );
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
        return {
          pageId,
          ok: true,
          id,
          status: existed ? "updated" : "created",
        };
      },
      {
        // Isolate: one malformed page can't sink the rest of the import.
        onError: (pageId, _i, error) => ({
          pageId,
          ok: false,
          error: getErrorMessage(error),
        }),
        finalize: async (summary) => {
          if (insertedIds.length > 0) {
            await ctx.services.recipeCosting.dispatchRecompute(insertedIds, {
              source: "recipe.syncNotionCookbook",
            });
            await runMutationSideEffectsForEntities(
              ctx.db,
              insertedIds.map((id) => ({
                action: "updated" as const,
                entity: { entityType: "recipe" as const, entityId: id },
                source: "recipe.notionSync",
              })),
            );
          }
          return summary;
        },
      },
    );
  });

// Distinct cookbooks with recipe counts, for the browse-by-source index.
const listCookbooksEndpoint = protectedProcedure
  .output(cookbookSummariesOut)
  .query(async ({ ctx }) => {
    return await listCookbooks(ctx.db);
  });

// Bulk-delete every recipe linked to one cookbook (cascades to sections,
// ingredients, and images via the shared deleteRecipes path).
const deleteByCookbook = protectedProcedure
  .input(cookbookIdInput)
  .output(deleteCookbookRecipesOut)
  .mutation(async ({ ctx, input }) => {
    const recipeIds = (
      await getCookbookRecipesForDiff(ctx.db, input.cookbookId)
    ).map((row) => row.id as RecipeId);
    const result = await deleteRecipesByCookbook(
      ctx.db,
      input.cookbookId,
      ctx.actorContext,
    );
    await runMutationSideEffectsForEntities(
      ctx.db,
      recipeIds.map((id) => ({
        action: "deleted" as const,
        entity: { entityType: "recipe" as const, entityId: id },
        source: "recipe.deleteByCookbook",
      })),
    );
    return result;
  });

// Re-derive a cookbook's recipes from its stored raw JSON (re-runs the WASM
// ingredient parser, no LLM) in ONE streamed request. Yields per-recipe progress
// for a live bar, then runs a single batched recompute and yields the final
// summary (how many were reprocessed + any extracted recipes never imported).
const reprocessCookbookStreamEndpoint = protectedProcedure
  .input(cookbookIdInput)
  // A mutation (it re-derives + writes recipes); streams progress like a query.
  .mutation(async function* ({ ctx, input }) {
    yield* streamProgress(
      reprocessCookbookStream(ctx.db, input.cookbookId, ctx.actorContext),
      async ({ recipeIds, reprocessed, importableExtras }) => {
        await ctx.services.recipeCosting.dispatchRecompute(recipeIds, {
          source: "recipe.reprocessCookbook",
        });
        return { reprocessed, importableExtras };
      },
    );
  });

const extractCookbookChunkProc = protectedProcedure
  .input(chunkRequestInput)
  .output(chunkResponseOut)
  .mutation(async ({ ctx, input }) => {
    return await extractCookbookChunk(
      {
        system: input.system,
        user: input.user,
        toolName: input.toolName,
        toolSchema: input.toolSchema,
        escalate: input.escalate ?? false,
      },
      { db: ctx.db },
    );
  });

export const recipeImportProcedures = {
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
};

import {
  parseShortcodeFor,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import type {
  chunkRequestInput,
  cookbookDiffInput,
  cookbookIdInput,
  importCookbookStreamInput,
  importNotionSyncInput,
  importRecipeSchema,
  parseRecipeHtmlInput,
  scrapeRecipeInput,
  setCookbookProductInput,
  upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import { uniq } from "es-toolkit";
import type { z } from "zod";

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
  deleteCookbook,
  getCookbookByName,
  getCookbookSource,
  reprocessCookbookStream,
  setCookbookProduct,
  upsertCookbook,
} from "~/server/repo/cookbook";
import {
  type CookbookImportContext,
  upsertCookbookRecipeFromCookbook,
  upsertImportRecipe,
  upsertNotionRecipeFromImport,
} from "~/server/repo/import-recipe-convert";
import {
  getCookbookRecipeIdsByTitle,
  getCookbookRecipesForDiff,
  getNotionRecipePageIds,
  getNotionRecipesForDiff,
} from "~/server/repo/recipe";
import { findParentRecipeIdsBatch } from "~/server/repo/recipe/totals";
import { bindShortcodeResolver } from "~/server/repo/shortcode-resolver";
import {
  type ImageUrlImportPort,
  importRecipeImageFromUrl,
  productionRecipeImageImportPort,
} from "~/server/services/image-import";
import {
  deleteStoredObjects,
  importImageFromUrl as importStoredImageFromUrl,
} from "~/server/services/image-storage.service";
import {
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { findOrCreateByUPC } from "~/server/services/product-orchestration.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { extractCookbookChunk } from "~/server/utils/cookbook-llm";
import {
  lintImportRecipe,
  notionPageToImportRecipe,
} from "~/server/utils/notion-recipe";
import {
  htmlToImportRecipe,
  scrapeToImportRecipe,
} from "~/server/utils/scraper";

const cookbookShortcodes = bindShortcodeResolver("cookbook");
const productShortcodes = bindShortcodeResolver("product");

export const scrapeWorkflow = (input: z.output<typeof scrapeRecipeInput>) =>
  scrapeToImportRecipe(input);
export const parseHtmlWorkflow = (
  input: z.output<typeof parseRecipeHtmlInput>,
) => htmlToImportRecipe(input.html, input.url);

export interface RecipeImportWorkflowPorts {
  importImageFromUrl: ImageUrlImportPort;
}

const productionRecipeImportWorkflowPorts: RecipeImportWorkflowPorts = {
  importImageFromUrl: importStoredImageFromUrl,
};

export const insertImportWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof importRecipeSchema>,
  ports: RecipeImportWorkflowPorts = productionRecipeImportWorkflowPorts,
) => {
  const result = await upsertImportRecipe(
    input,
    context.db,
    context.actorContext,
  );
  if (input.image)
    await importRecipeImageFromUrl(context.db, result.id, input.image, {
      ...productionRecipeImageImportPort,
      importFromUrl: ports.importImageFromUrl,
    });
  await context.services.recipeCosting.dispatchRecompute([result.id], {
    source: "recipe.import",
    entity: { entityType: "recipe", entityId: result.id },
  });
  await runMutationSideEffects(context.db, {
    action: "updated",
    entity: { entityType: "recipe", entityId: result.id },
    source: "recipe.import",
  });
  return { id: parseShortcodeFor("recipe", result.shortcode) };
};

export const upsertCookbookWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof upsertCookbookInput>,
) => {
  const result = await upsertCookbook(context.db, input, {
    ...context.actorContext,
    source: "epub_import",
  });
  await runMutationSideEffects(context.db, {
    action: "updated",
    entity: { entityType: "cookbook", entityId: result.entityId },
    source: "cookbook.upsert",
  });
  if (input.isbn) {
    try {
      const { product } = await findOrCreateByUPC(
        context.db,
        context.usdaClient,
        context.upcLookupClient,
        input.isbn,
        input.name,
        context.actorContext,
      );
      await setCookbookProduct(
        context.db,
        context.actorContext,
        result.entityId,
        await productShortcodes.one(context.db, product.id),
      );
    } catch (error) {
      console.error(
        `[cookbook.upsert] ISBN ${input.isbn} did not resolve to a product; link it by hand:`,
        error,
      );
    }
  }
  return result.output;
};

export const getCookbookSourceWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof cookbookIdInput>,
) => {
  const source = await getCookbookSource(
    context.db,
    await cookbookShortcodes.one(context.db, input.cookbookId),
  );
  return { ...source, id: input.cookbookId };
};

type ImportItemResult =
  | { index: number; ok: true; id: RecipeShortcode }
  | { index: number; ok: false; error: string };
type ImportSummary = { succeeded: number; failed: number };
export async function* importCookbookWorkflow(
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof importCookbookStreamInput>,
): AsyncGenerator<BulkProgressEvent<ImportItemResult, ImportSummary>> {
  const actor = { ...context.actorContext, source: "epub_import" as const };
  const cookbookId = await cookbookShortcodes.one(context.db, input.cookbookId);
  const { name, recipes } = await getCookbookSource(context.db, cookbookId);
  const importContext: CookbookImportContext = {
    titleToId: await getCookbookRecipeIdsByTitle(context.db, cookbookId),
    ingredientIdByName: new Map(),
  };
  const insertedIds: RecipeId[] = [];
  yield* streamItems<number, ImportItemResult, ImportSummary>(
    input.indices,
    async (index) => {
      const recipe = recipes[index];
      if (!recipe)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Recipe index ${index} is out of range for this cookbook`,
        );
      const { id, shortcode } = await upsertCookbookRecipeFromCookbook(
        recipe,
        { id: cookbookId, name },
        context.db,
        actor,
        importContext,
      );
      insertedIds.push(id);
      return { index, ok: true, id: parseShortcodeFor("recipe", shortcode) };
    },
    {
      onError: (index, _i, error) => ({
        index,
        ok: false,
        error: getErrorMessage(error),
      }),
      finalize: async (summary) => {
        if (insertedIds.length) {
          const source = "recipe.importCookbookStream";
          await context.services.recipeCosting.dispatchRecompute(insertedIds, {
            source,
          });
          await runMutationSideEffectsForEntities(
            context.db,
            insertedIds.map((id) => ({
              action: "updated" as const,
              entity: { entityType: "recipe" as const, entityId: id },
              source,
            })),
          );
        }
        return summary;
      },
    },
  );
}

export const getCookbookDiffWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof cookbookDiffInput>,
) => {
  const cookbook = await getCookbookByName(context.db, input.book);
  return cookbook ? getCookbookRecipesForDiff(context.db, cookbook.id) : [];
};

const normalizeNotionId = (id: string) => id.replace(/-/g, "");
export const previewNotionSyncWorkflow = async (
  context: AuthenticatedStartOperationContext,
) => {
  const client = context.notionClient;
  if (!client) return [];
  const rows = await client.queryRecipes();
  const existing = new Map(
    (await getNotionRecipesForDiff(context.db)).map((entry) => [
      normalizeNotionId(entry.pageId),
      { id: entry.recipe.id, sig: recipeOutSignature(entry.recipe) },
    ]),
  );
  return Promise.all(
    rows.map(async (row) => {
      const recipe = notionPageToImportRecipe(
        row,
        await client.getPageContent(row.id),
      );
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
};

type NotionItemResult =
  | {
      pageId: string;
      ok: true;
      id: RecipeShortcode;
      status: "created" | "updated";
    }
  | { pageId: string; ok: false; error: string };
type NotionSummary = { succeeded: number; failed: number };
export async function* importNotionSyncWorkflow(
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof importNotionSyncInput>,
): AsyncGenerator<BulkProgressEvent<NotionItemResult, NotionSummary>> {
  const client = context.notionClient;
  if (!client)
    throw createAppError("CONSTRAINT_VIOLATION", "Notion is not configured.");
  const rowById = new Map(
    (await client.queryRecipes()).map((row) => [row.id, row]),
  );
  const existing = new Set(
    (await getNotionRecipePageIds(context.db)).map(normalizeNotionId),
  );
  const insertedIds: RecipeId[] = [];
  yield* streamItems<string, NotionItemResult, NotionSummary>(
    input.pageIds,
    async (pageId) => {
      const row = rowById.get(pageId);
      if (!row)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "That page isn't in the Notion Recipes database.",
        );
      const recipe = notionPageToImportRecipe(
        row,
        await client.getPageContent(pageId),
      );
      const { status, reasons } = lintImportRecipe(recipe);
      if (status === "needs-formatting")
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Recipe isn't import-ready: ${reasons.join(" ")}`,
        );
      const result = await upsertNotionRecipeFromImport(
        recipe,
        pageId,
        row.tags,
        context.db,
        context.actorContext,
      );
      insertedIds.push(result.id);
      return {
        pageId,
        ok: true,
        id: parseShortcodeFor("recipe", result.shortcode),
        status: existing.has(normalizeNotionId(pageId)) ? "updated" : "created",
      };
    },
    {
      onError: (pageId, _i, error) => ({
        pageId,
        ok: false,
        error: getErrorMessage(error),
      }),
      finalize: async (summary) => {
        if (insertedIds.length) {
          const source = "recipe.importNotionSyncStream";
          await context.services.recipeCosting.dispatchRecompute(insertedIds, {
            source,
          });
          await runMutationSideEffectsForEntities(
            context.db,
            insertedIds.map((id) => ({
              action: "updated" as const,
              entity: { entityType: "recipe" as const, entityId: id },
              source,
            })),
          );
        }
        return summary;
      },
    },
  );
}

export const setCookbookProductWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof setCookbookProductInput>,
) =>
  setCookbookProduct(
    context.db,
    context.actorContext,
    await cookbookShortcodes.one(context.db, input.cookbookId),
    input.productId
      ? await productShortcodes.one(context.db, input.productId)
      : null,
  );

export const deleteCookbookWorkflow = async (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof cookbookIdInput>,
) => {
  const cookbookId = await cookbookShortcodes.one(context.db, input.cookbookId);
  const recipeIds = (
    await getCookbookRecipesForDiff(context.db, cookbookId)
  ).map((row) => row.entityId);
  const deletedSet = new Set<RecipeId>(recipeIds);
  const parentsByRecipe = await findParentRecipeIdsBatch(context.db, recipeIds);
  const parentIds = uniq(
    [...parentsByRecipe.values()].flat().filter((id) => !deletedSet.has(id)),
  );
  const { deletedRecipeIds, detachedImageKeys } = await deleteCookbook(
    context.db,
    cookbookId,
    context.actorContext,
  );
  await deleteStoredObjects(detachedImageKeys);
  await runMutationSideEffectsForEntities(
    context.db,
    deletedRecipeIds.map((id) => ({
      action: "deleted" as const,
      entity: { entityType: "recipe" as const, entityId: id },
      source: "recipe.deleteCookbook",
    })),
  );
  if (parentIds.length)
    await context.services.recipeCosting.dispatchRecompute(parentIds, {
      source: "recipe.deleteCookbook",
    });
  return { deletedRecipes: deletedRecipeIds.length };
};

export async function* reprocessCookbookWorkflow(
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof cookbookIdInput>,
) {
  const cookbookId = await cookbookShortcodes.one(context.db, input.cookbookId);
  yield* streamProgress(
    reprocessCookbookStream(context.db, cookbookId, context.actorContext),
    async ({ recipeIds, reprocessed, importableExtras }) => {
      await context.services.recipeCosting.dispatchRecompute(recipeIds, {
        source: "recipe.reprocessCookbook",
      });
      return { reprocessed, importableExtras };
    },
  );
}
export const extractCookbookChunkWorkflow = (
  context: AuthenticatedStartOperationContext,
  input: z.output<typeof chunkRequestInput>,
) =>
  extractCookbookChunk(
    {
      system: input.system,
      user: input.user,
      toolName: input.toolName,
      toolSchema: input.toolSchema,
      escalate: input.escalate ?? false,
    },
    { db: context.db },
  );

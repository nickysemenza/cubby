import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import {
  type CookbookId,
  parseShortcodeFor,
  type RecipeId,
} from "@cubby/schemas/identifiers";
import type {
  attachCookbookRecipePhotoInput,
  cookbookDiffInput,
  cookbookIdInput,
  gatewayForwardInput,
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

import { topoOrder } from "~/lib/cookbook-graph";
import { getErrorMessage } from "~/lib/error-utils";
import {
  importRecipeSignature,
  recipeOutSignature,
} from "~/lib/recipe-signature";
import { appErrorFromUnknown, createAppError } from "~/server/errors/app-error";
import {
  cookbookRecipesById,
  deleteCookbook,
  getCookbookByName,
  getCookbookRecipePhotoSource,
  getCookbookSource,
  prepareCookbookReprocessing,
  reprocessCookbookRecipe,
  setCookbookProduct,
  upsertCookbook,
} from "~/server/repo/cookbook";
import { recipeHasImages } from "~/server/repo/image";
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
  actorWithRun,
  cookbookRunInput,
  ensureRun,
} from "~/server/runs/ensure-run";
import {
  type ImageUrlImportPort,
  importRecipeImageFromUrl,
  productionRecipeImageImportPort,
} from "~/server/services/image-import";
import {
  attachFileToEntity,
  deleteStoredObjects,
  importImageFromUrl as importStoredImageFromUrl,
} from "~/server/services/image-storage.service";
import {
  mutationEvents,
  runMutationSideEffects,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { findOrCreateByUPC } from "~/server/services/product-orchestration.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { forwardGatewayRequest } from "~/server/utils/gateway-forward";
import {
  lintImportRecipe,
  notionPageToImportRecipe,
} from "~/server/utils/notion-recipe";
import {
  htmlToImportRecipe,
  scrapeToImportRecipe,
} from "~/server/utils/scraper";
import {
  bindBulkWorkflow,
  bindWorkflow,
  defineBulkWorkflow,
  defineWorkflowOperation,
  executeBulkWorkflow,
  executeWorkflow,
  type BulkWorkflowSummary,
  workflow,
} from "~/server/workflow-runtime";
import {
  projectCookbookImportEvent,
  projectNotionImportEvent,
  type CookbookImportProjection,
  type NotionImportProjection,
} from "~/server/workflows/recipe-import-projection";

const cookbookShortcodes = bindShortcodeResolver("cookbook");
const productShortcodes = bindShortcodeResolver("product");
const recipeShortcodes = bindShortcodeResolver("recipe");

export const scrapeWorkflow = defineWorkflowOperation(
  "recipe.scrape",
  (input: z.output<typeof scrapeRecipeInput>) => scrapeToImportRecipe(input),
);
export const parseHtmlWorkflow = defineWorkflowOperation(
  "recipe.parseHtml",
  (input: z.output<typeof parseRecipeHtmlInput>) =>
    Promise.resolve(htmlToImportRecipe(input.html, input.url)),
);

export interface RecipeImportWorkflowPorts {
  importImageFromUrl: ImageUrlImportPort;
}

const productionRecipeImportWorkflowPorts: RecipeImportWorkflowPorts = {
  importImageFromUrl: importStoredImageFromUrl,
};

type ImportRecipeInput = z.output<typeof importRecipeSchema>;
type ImportRecipeContext = {
  operation: AuthenticatedStartOperationContext;
  ports: RecipeImportWorkflowPorts;
};
export const insertImportWorkflow = bindWorkflow(
  workflow<ImportRecipeContext, ImportRecipeInput>("recipe.insertImport")
    .commit("imported", async ({ context }, { input }) =>
      upsertImportRecipe(
        input,
        context.operation.db,
        context.operation.actorContext,
      ),
    )
    .effect("image", async ({ context }, { input, imported }) => {
      if (input.image?.kind !== "url") return undefined;
      return importRecipeImageFromUrl(
        context.operation.db,
        imported.id,
        input.image.url,
        {
          ...productionRecipeImageImportPort,
          importFromUrl: context.ports.importImageFromUrl,
        },
      );
    })
    .effect("costing", ({ context }, { imported }) =>
      context.operation.services.recipeCosting.dispatchRecompute(
        [imported.id],
        {
          source: "recipe.import",
          entity: { entityType: "recipe", entityId: imported.id },
        },
      ),
    )
    .effect("sideEffects", ({ context }, { imported }) =>
      runMutationSideEffects(context.operation.db, {
        action: "updated",
        entity: { entity: "recipe", id: imported.id },
        source: "recipe.import",
      }),
    )
    .output(({ imported }) => ({
      id: parseShortcodeFor("recipe", imported.shortcode),
    })),
  (
    operation: AuthenticatedStartOperationContext,
    input: ImportRecipeInput,
    ports: RecipeImportWorkflowPorts = productionRecipeImportWorkflowPorts,
  ) => ({ context: { operation, ports }, input }),
);

type UpsertCookbookInput = z.output<typeof upsertCookbookInput>;
export const upsertCookbookWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, UpsertCookbookInput>(
    "recipe.upsertCookbook",
  )
    // Before the commit: the run must not roll back with a failed upsert.
    .call("actor", ({ context }, { input }) =>
      actorWithRun(
        context.db,
        context.actorContext,
        cookbookRunInput(input.name),
      ),
    )
    .commit("upserted", ({ context }, { input, actor }) =>
      upsertCookbook(context.db, input, actor),
    )
    .effect("sideEffects", ({ context }, { upserted }) =>
      runMutationSideEffects(context.db, {
        action: "updated",
        entity: { entity: "cookbook", id: upserted.entityId },
        source: "cookbook.upsert",
      }),
    )
    .effect("isbnLink", async ({ context }, { input, upserted }) => {
      if (!input.isbn) return undefined;
      try {
        const { product } = await findOrCreateByUPC(
          context.db,
          context.usdaClient,
          context.upcLookupClient,
          input.isbn,
          input.name,
          context.actorContext,
        );
        return setCookbookProduct(
          context.db,
          context.actorContext,
          upserted.entityId,
          await productShortcodes.one(context.db, product.id),
        );
      } catch (error) {
        console.error(
          `[cookbook.upsert] ISBN ${input.isbn} did not resolve to a product; link it by hand:`,
          error,
        );
        return undefined;
      }
    })
    .output(({ upserted }) => upserted.output),
);

type CookbookIdInput = z.output<typeof cookbookIdInput>;
export const getCookbookSourceWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, CookbookIdInput>(
    "recipe.getCookbookSource",
  )
    .call("cookbookId", ({ context }, { input }) =>
      cookbookShortcodes.one(context.db, input.cookbookId),
    )
    .call("source", ({ context }, { input, cookbookId }) =>
      getCookbookSource(context.db, cookbookId).then((source) => ({
        ...source,
        id: input.cookbookId,
      })),
    )
    .output(({ source }) => source),
);

type CookbookRecipePhotoInput = z.output<typeof attachCookbookRecipePhotoInput>;

export interface CookbookRecipePhotoPorts {
  attachFile: typeof attachFileToEntity;
}

const productionCookbookRecipePhotoPorts: CookbookRecipePhotoPorts = {
  attachFile: attachFileToEntity,
};

type PhotoWorkflowContext = {
  db: AuthenticatedStartOperationContext["db"];
  ports: CookbookRecipePhotoPorts;
};
export const attachCookbookRecipePhotoWorkflow = bindWorkflow(
  workflow<PhotoWorkflowContext, CookbookRecipePhotoInput>(
    "recipe.attachCookbookRecipePhoto",
  )
    .call("cookbookId", ({ context }, { input }) =>
      cookbookShortcodes.one(context.db, input.cookbookId),
    )
    .call("recipeId", ({ context }, { input }) =>
      recipeShortcodes.one(context.db, input.recipeId),
    )
    .call("source", ({ context }, { input, cookbookId, recipeId }) =>
      getCookbookRecipePhotoSource(
        context.db,
        cookbookId,
        recipeId,
        input.sourceRecipeId,
      ),
    )
    .call("hasImages", ({ context }, { recipeId }) =>
      recipeHasImages(context.db, recipeId),
    )
    .branch("attachment", {
      when: (_, { hasImages }) => Promise.resolve(hasImages),
      whenTrue: (branch) =>
        branch.output(() => ({ status: "skipped-existing" as const })),
      whenFalse: (branch) =>
        branch
          .call("request", async (_, { input: values }) => {
            const { input, source } = values;
            const filename = source.path.split("/").at(-1) || "recipe-photo";
            const pathDigest = Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(source.path),
                ),
              ),
              (byte) => byte.toString(16).padStart(2, "0"),
            ).join("");
            return {
              entityType: "recipe" as const,
              entityId: input.recipeId,
              data: input.data,
              contentType: source.mime,
              filename,
              idempotencyKey: `epub-photo:${input.recipeId}:${pathDigest}`,
              expectedImageCount: 0,
            };
          })
          .commit("attached", async ({ context }, { request }) => {
            try {
              const attached = await context.ports.attachFile(
                context.db,
                request,
              );
              return attached.cleanupWarning
                ? {
                    status: attached.reused
                      ? ("reused" as const)
                      : ("attached" as const),
                    cleanupWarning: attached.cleanupWarning,
                  }
                : {
                    status: attached.reused
                      ? ("reused" as const)
                      : ("attached" as const),
                  };
            } catch (error) {
              const appError = appErrorFromUnknown(error);
              if (appError?.reason === "IMAGE_PRECONDITION_FAILED")
                return { status: "skipped-existing" as const };
              if (appError) throw appError;
              throw createAppError(
                "IMAGE_ATTACH_FAILED",
                "Could not attach the cookbook recipe photo",
                error,
              );
            }
          })
          .output(({ attached }) => attached),
    })
    .output(({ attachment }) => attachment),
  (
    context: Pick<AuthenticatedStartOperationContext, "db"> &
      Partial<Pick<AuthenticatedStartOperationContext, "actorContext">>,
    input: CookbookRecipePhotoInput,
    ports: CookbookRecipePhotoPorts = productionCookbookRecipePhotoPorts,
  ) => ({ context: { db: context.db, ports }, input }),
);

type ImportSummary = { succeeded: number; failed: number };
type CookbookImportItem = {
  readonly sourceRecipeId: string;
  readonly recipe:
    | { readonly recipe: CookbookRecipe; readonly chapter: string | null }
    | undefined;
  readonly cookbook: { readonly id: CookbookId; readonly name: string };
  readonly importContext: CookbookImportContext;
};
type CookbookImportResult = CookbookImportProjection;
const cookbookImportDefinition = defineBulkWorkflow({
  name: "recipe.importCookbookStream",
  items: workflow<
    AuthenticatedStartOperationContext,
    z.output<typeof importCookbookStreamInput>
  >("recipe.importCookbookStream.select")
    .call("cookbookId", ({ context }, { input }) =>
      cookbookShortcodes.one(context.db, input.cookbookId),
    )
    .call("source", ({ context }, { cookbookId }) =>
      getCookbookSource(context.db, cookbookId),
    )
    .call("importContext", async ({ context }, { cookbookId, source }) => ({
      titleToId: await getCookbookRecipeIdsByTitle(context.db, cookbookId),
      extraction: source.cookbook,
      ingredientIdByName: new Map(),
    }))
    // Dependency order: a sub-recipe imports before the recipe that uses it,
    // so the reference links on its first insert.
    .output(({ input, cookbookId, source, importContext }) => {
      const byId = cookbookRecipesById(source.cookbook);
      return topoOrder(source.cookbook, input.recipeIds).map(
        (sourceRecipeId): CookbookImportItem => ({
          sourceRecipeId,
          recipe: byId.get(sourceRecipeId),
          cookbook: { id: cookbookId, name: source.name },
          importContext,
        }),
      );
    }),
  item: workflow<AuthenticatedStartOperationContext, CookbookImportItem>(
    "recipe.importCookbookStream.item",
  )
    .call("recipe", async (_, { input }) => {
      if (input.recipe) return input.recipe;
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        `Recipe ${input.sourceRecipeId} is not in this cookbook's extraction`,
      );
    })
    // Before the commit: the run must not roll back with a failed item.
    .call("actor", ({ context }, { input }) =>
      actorWithRun(
        context.db,
        context.actorContext,
        cookbookRunInput(input.cookbook.name),
      ),
    )
    .commit("imported", ({ context }, { input, recipe, actor }) =>
      upsertCookbookRecipeFromCookbook(
        recipe.recipe,
        recipe.chapter,
        input.cookbook,
        context.db,
        actor,
        input.importContext,
      ),
    )
    .effect("event", ({ context }, { input, imported }) =>
      projectCookbookImportEvent(
        input.sourceRecipeId,
        imported,
        recipeHasImages(context.db, imported.id),
      ),
    )
    .output(({ event }) => event),
  finalize: workflow<
    AuthenticatedStartOperationContext,
    BulkWorkflowSummary<CookbookImportItem, CookbookImportResult>
  >("recipe.importCookbookStream.finalize")
    .commit("costing", async ({ context }, { input }) => {
      const recipeIds = input.succeeded.map(({ result }) => result.recipeId);
      return recipeIds.length
        ? context.services.recipeCosting.dispatchRecompute(recipeIds, {
            source: "recipe.importCookbookStream",
          })
        : 0;
    })
    .effect("sideEffects", async ({ context }, { input }) => {
      const recipeIds = input.succeeded.map(({ result }) => result.recipeId);
      if (recipeIds.length === 0) return;
      await runMutationSideEffectsForEntities(
        context.db,
        mutationEvents(
          "recipe",
          "updated",
          recipeIds,
          "recipe.importCookbookStream",
        ),
      );
    })
    .output(({ input }): ImportSummary => ({
      succeeded: input.succeeded.filter(({ result }) => result.event.ok).length,
      failed:
        input.failed.length +
        input.succeeded.filter(({ result }) => !result.event.ok).length,
    })),
  onItemError: "continue",
  progress: (result) => result.event,
  errorProgress: (error, item) => ({
    sourceRecipeId: item.sourceRecipeId,
    ok: false as const,
    error: getErrorMessage(error),
  }),
});
export const importCookbookWorkflow = bindBulkWorkflow(
  cookbookImportDefinition,
  (
    context: AuthenticatedStartOperationContext,
    input: z.output<typeof importCookbookStreamInput>,
    signal?: AbortSignal,
  ) => ({ context, input, signal }),
);

type CookbookDiffInput = z.output<typeof cookbookDiffInput>;
export const getCookbookDiffWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, CookbookDiffInput>(
    "recipe.getCookbookDiff",
  )
    .call(
      "cookbook",
      async ({ context }, { input }) =>
        await getCookbookByName(context.db, input.book),
    )
    .branch("recipes", {
      when: async (_, { cookbook }) => cookbook != null,
      whenTrue: (branch) =>
        branch
          .call("read", async ({ context }, { input }) =>
            input.cookbook
              ? await getCookbookRecipesForDiff(context.db, input.cookbook.id)
              : [],
          )
          .output(({ read }) => read),
      whenFalse: (branch) => branch.output(() => []),
    })
    .output(({ recipes }) => recipes),
);

const normalizeNotionId = (id: string) => id.replace(/-/g, "");
const previewNotionSyncDefinition = workflow<
  AuthenticatedStartOperationContext,
  undefined
>("recipe.previewNotionSync")
  .branch("client", {
    when: async ({ context }) => context.notionClient != null,
    whenFalse: (branch) => branch.output(() => []),
    whenTrue: (branch) =>
      branch
        .call("rows", async ({ context }) => {
          const client = context.notionClient;
          if (!client) return [];
          return await client.queryRecipes();
        })
        .call(
          "existing",
          async ({ context }) =>
            new Map(
              (await getNotionRecipesForDiff(context.db)).map((entry) => [
                normalizeNotionId(entry.pageId),
                { id: entry.recipe.id, sig: recipeOutSignature(entry.recipe) },
              ]),
            ),
        )
        .map("pages", {
          items: ({ rows, existing }) => rows.map((row) => ({ row, existing })),
          concurrency: 10,
          run: async ({ context }, { item }) => {
            const client = context.notionClient;
            if (!client)
              throw new Error("Notion client disappeared during preview");
            const { row, existing } = item;
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
          },
        })
        .output(({ pages }) => pages),
  })
  .output(({ client }) => client);

export const previewNotionSyncWorkflow = bindWorkflow(
  previewNotionSyncDefinition,
  (context: AuthenticatedStartOperationContext) => ({
    context,
    input: undefined,
  }),
);

type NotionSummary = { succeeded: number; failed: number };
type NotionImportItem = {
  readonly pageId: string;
  readonly row:
    | Awaited<
        ReturnType<
          NonNullable<
            AuthenticatedStartOperationContext["notionClient"]
          >["queryRecipes"]
        >
      >[number]
    | null;
  readonly existing: boolean;
};
type NotionImportResult = NotionImportProjection;
const notionImportDefinition = defineBulkWorkflow({
  name: "recipe.importNotionSyncStream",
  items: workflow<
    AuthenticatedStartOperationContext,
    z.output<typeof importNotionSyncInput>
  >("recipe.importNotionSyncStream.select")
    .call("client", async ({ context }) => {
      if (!context.notionClient)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Notion is not configured.",
        );
      return context.notionClient;
    })
    .call("rows", async (_, { client }) => client.queryRecipes())
    .call("existing", ({ context }) =>
      getNotionRecipePageIds(context.db).then(
        (pageIds) => new Set(pageIds.map(normalizeNotionId)),
      ),
    )
    .output(({ input, rows, existing }) => {
      const rowById = new Map(rows.map((row) => [row.id, row]));
      return input.pageIds.map((pageId): NotionImportItem => ({
        pageId,
        row: rowById.get(pageId) ?? null,
        existing: existing.has(normalizeNotionId(pageId)),
      }));
    }),
  item: workflow<AuthenticatedStartOperationContext, NotionImportItem>(
    "recipe.importNotionSyncStream.item",
  )
    .call("row", async (_, { input }) => {
      if (input.row) return input.row;
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "That page isn't in the Notion Recipes database.",
      );
    })
    .call("recipe", async ({ context }, { input, row }) => {
      const client = context.notionClient;
      if (!client) throw new Error("Notion client was lost after selection.");
      const recipe = notionPageToImportRecipe(
        row,
        await client.getPageContent(input.pageId),
      );
      const { status, reasons } = lintImportRecipe(recipe);
      if (status === "needs-formatting")
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Recipe isn't import-ready: ${reasons.join(" ")}`,
        );
      return recipe;
    })
    .commit("imported", ({ context }, { input, recipe, row }) =>
      upsertNotionRecipeFromImport(
        recipe,
        input.pageId,
        row.tags,
        context.db,
        context.actorContext,
      ),
    )
    .effect("event", async (_, { input, imported }) =>
      projectNotionImportEvent(input.pageId, input.existing, imported),
    )
    .output(({ event }) => event),
  finalize: workflow<
    AuthenticatedStartOperationContext,
    BulkWorkflowSummary<NotionImportItem, NotionImportResult>
  >("recipe.importNotionSyncStream.finalize")
    .commit("costing", ({ context }, { input }) => {
      const recipeIds = input.succeeded.map(({ result }) => result.recipeId);
      return recipeIds.length
        ? context.services.recipeCosting.dispatchRecompute(recipeIds, {
            source: "recipe.importNotionSyncStream",
          })
        : Promise.resolve(0);
    })
    .effect("sideEffects", ({ context }, { input }) => {
      const recipeIds = input.succeeded.map(({ result }) => result.recipeId);
      return recipeIds.length
        ? runMutationSideEffectsForEntities(
            context.db,
            mutationEvents(
              "recipe",
              "updated",
              recipeIds,
              "recipe.importNotionSyncStream",
            ),
          )
        : Promise.resolve();
    })
    .output(({ input }): NotionSummary => ({
      succeeded: input.succeeded.filter(({ result }) => result.event.ok).length,
      failed:
        input.failed.length +
        input.succeeded.filter(({ result }) => !result.event.ok).length,
    })),
  onItemError: "continue",
  progress: (result) => result.event,
  errorProgress: (error, item) => ({
    pageId: item.pageId,
    ok: false as const,
    error: getErrorMessage(error),
  }),
});
export const importNotionSyncWorkflow = bindBulkWorkflow(
  notionImportDefinition,
  (
    context: AuthenticatedStartOperationContext,
    input: z.output<typeof importNotionSyncInput>,
    signal?: AbortSignal,
  ) => ({ context, input, signal }),
);

type SetCookbookProductInput = z.output<typeof setCookbookProductInput>;
export const setCookbookProductWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, SetCookbookProductInput>(
    "recipe.setCookbookProduct",
  )
    .call("cookbookId", ({ context }, { input }) =>
      cookbookShortcodes.one(context.db, input.cookbookId),
    )
    .call("productId", async ({ context }, { input }) =>
      input.productId
        ? productShortcodes.one(context.db, input.productId)
        : null,
    )
    .commit("updated", ({ context }, { cookbookId, productId }) =>
      setCookbookProduct(
        context.db,
        context.actorContext,
        cookbookId,
        productId,
      ),
    )
    .output(({ updated }) => updated),
  (
    context: AuthenticatedStartOperationContext,
    input: SetCookbookProductInput,
  ) => ({ context, input }),
);

type DeleteCookbookInput = z.output<typeof cookbookIdInput>;
export const deleteCookbookWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, DeleteCookbookInput>(
    "recipe.deleteCookbook",
  )
    .call("cookbookId", ({ context }, { input }) =>
      cookbookShortcodes.one(context.db, input.cookbookId),
    )
    .call("recipeIds", async ({ context }, { cookbookId }) =>
      (await getCookbookRecipesForDiff(context.db, cookbookId)).map(
        (row) => row.entityId,
      ),
    )
    .call("parentIds", ({ context }, { recipeIds }) =>
      findParentRecipeIdsBatch(context.db, recipeIds).then((parentsByRecipe) =>
        uniq(
          [...parentsByRecipe.values()]
            .flat()
            .filter((id) => !recipeIds.includes(id)),
        ),
      ),
    )
    .commit("deleted", ({ context }, { cookbookId }) =>
      deleteCookbook(context.db, cookbookId, context.actorContext),
    )
    .effect("storage", (_, { deleted }) =>
      deleteStoredObjects(deleted.detachedImageKeys),
    )
    .effect("sideEffects", ({ context }, { deleted }) =>
      runMutationSideEffectsForEntities(
        context.db,
        mutationEvents(
          "recipe",
          "deleted",
          deleted.deletedRecipeIds,
          "recipe.deleteCookbook",
        ),
      ),
    )
    .effect("costing", ({ context }, { parentIds }) =>
      parentIds.length
        ? context.services.recipeCosting.dispatchRecompute(parentIds, {
            source: "recipe.deleteCookbook",
          })
        : Promise.resolve(0),
    )
    .output(({ deleted }) => ({
      deletedRecipes: deleted.deletedRecipeIds.length,
    })),
);

type ReprocessPreparedContext = {
  readonly operation: AuthenticatedStartOperationContext;
  readonly selection: Awaited<ReturnType<typeof prepareCookbookReprocessing>>;
};
type ReprocessPreparedInput = {
  readonly recipes: Awaited<
    ReturnType<typeof prepareCookbookReprocessing>
  >["recipes"];
};
const reprocessCookbookPreparation = workflow<
  AuthenticatedStartOperationContext,
  z.output<typeof cookbookIdInput>
>("recipe.reprocessCookbook.prepare")
  .call("cookbookId", ({ context }, { input }) =>
    cookbookShortcodes.one(context.db, input.cookbookId),
  )
  .call("selection", ({ context }, { cookbookId }) =>
    prepareCookbookReprocessing(context.db, cookbookId),
  )
  .call("prepared", async ({ context }, { selection }) => ({
    context: { operation: context, selection },
    input: { recipes: selection.recipes },
  }))
  .output(({ prepared }) => prepared);
const reprocessCookbookDefinition = defineBulkWorkflow({
  name: "recipe.reprocessCookbook",
  items: workflow<ReprocessPreparedContext, ReprocessPreparedInput>(
    "recipe.reprocessCookbook.items",
  ).output(({ input }) => input.recipes),
  item: workflow<
    ReprocessPreparedContext,
    ReprocessPreparedInput["recipes"][number]
  >("recipe.reprocessCookbook.item")
    .commit("reprocessed", ({ context }, { input }) =>
      reprocessCookbookRecipe(
        context.operation.db,
        context.selection,
        input,
        context.operation.actorContext,
      ),
    )
    .output(({ reprocessed }) => reprocessed),
  finalize: workflow<
    ReprocessPreparedContext,
    BulkWorkflowSummary<ReprocessPreparedInput["recipes"][number], RecipeId>
  >("recipe.reprocessCookbook.finalize")
    .commit("costing", ({ context }, { input }) =>
      context.operation.services.recipeCosting.dispatchRecompute(
        input.succeeded.map(({ result }) => result),
        { source: "recipe.reprocessCookbook" },
      ),
    )
    .effect("summary", async ({ context }, { input }) => ({
      reprocessed: input.succeeded.length,
      importableExtras: [...context.selection.importableExtras],
    }))
    .output(({ summary }) => summary),
  initialProgress: false,
  onItemError: "stop",
  progress: () => undefined,
});

export const reprocessCookbookWorkflow = Object.assign(
  (
    context: AuthenticatedStartOperationContext,
    input: z.output<typeof cookbookIdInput>,
    signal?: AbortSignal,
  ) => {
    const run = async function* () {
      const prepared = await executeWorkflow(reprocessCookbookPreparation, {
        context,
        input,
        signal,
      });
      const { context: preparedContext, input: preparedInput } = prepared;
      yield* executeBulkWorkflow(reprocessCookbookDefinition, {
        context: preparedContext,
        input: preparedInput,
        signal,
      });
    };
    return run();
  },
  { definition: reprocessCookbookDefinition },
);
type GatewayForwardInput = z.output<typeof gatewayForwardInput>;
export const forwardGatewayRequestWorkflow = defineWorkflowOperation(
  "recipe.forwardGatewayRequest",
  async (
    context: AuthenticatedStartOperationContext,
    input: GatewayForwardInput,
  ) => {
    const runId = await ensureRun(context.db, context.actorContext, {
      purpose: "ai_action",
    });
    return forwardGatewayRequest(input, {
      db: context.db,
      runId,
      feature: "cookbook-epub-parsing",
    });
  },
);

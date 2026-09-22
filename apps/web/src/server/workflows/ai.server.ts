import type {
  aiLocationIdInput,
  aiUsageRecentInput,
  aiUsageSummaryInput,
  approveDetectedInventoryItemInput,
  enrichmentProposalPrecomputeInput,
  externalIdKindSuggestionInput,
  fieldSuggestionsInput,
  ingredientMergeSuggestionBatchInput,
  productIdentificationInput,
  usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionInput,
} from "@cubby/schemas/ai";
import {
  parseEntityId,
  type IngredientId,
  type ImportRunId,
  type LocationId,
} from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { suggestExternalIdKind } from "~/server/ai/external-id-kind";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import { getAiClient } from "~/server/clients/ai";
import type { Database } from "~/server/db";
import { listRecentAiUsage, summarizeAiUsage } from "~/server/repo/ai-usage";
import {
  resolveAllOrThrow,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";
import {
  suggestIngredientMerge,
  suggestIngredientMergeBatch,
} from "~/server/services/ai-enrichment/ingredient-merge";
import {
  approveDetectedInventoryItem,
  describeLocation,
  detectInventoryItems,
  enqueueLocationDescriptionBackfill,
  selectLocationDescriptionBackfill,
} from "~/server/services/ai-enrichment/location-vision";
import type { EnrichmentProposal } from "~/server/services/ai-enrichment/proposals";
import {
  suggestUsdaFood,
  suggestUsdaFoodBatch,
} from "~/server/services/ai-enrichment/usda-match";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import {
  bindBulkWorkflow,
  bindCoordinatorStream,
  bindWorkflow,
  defineBulkWorkflow,
  defineCoordinatorStream,
  defineWorkflowOperation,
  type BulkWorkflowSummary,
  workflow,
} from "~/server/workflow-runtime";

type LocationIdInput = z.output<typeof aiLocationIdInput>;
/** The request's `ai_action` run; `ai-browser.server.ts` mints it once via
 * `ensureRun` before calling in. */
type AiActionRunContext = { db: Database; runId: ImportRunId };
export const describeLocationWorkflow = bindWorkflow(
  workflow<AiActionRunContext, LocationIdInput>("ai.describeLocation")
    .call("locationId", async ({ context }, { input }) =>
      resolveOrThrow(context.db, "location", input.locationId),
    )
    .commit("description", async ({ context }, { locationId }) =>
      describeLocation(context.db, locationId, context.runId),
    )
    .output(({ description }) => description),
  (context: AiActionRunContext, input: LocationIdInput) => ({
    context,
    input,
  }),
);

export const detectInventoryItemsWorkflow = bindWorkflow(
  workflow<AiActionRunContext, LocationIdInput>("ai.detectInventoryItems")
    .call("locationId", async ({ context }, { input }) =>
      resolveOrThrow(context.db, "location", input.locationId),
    )
    .commit("inventory", async ({ context }, { locationId }) =>
      detectInventoryItems(context.db, locationId, context.runId),
    )
    .output(({ inventory }) => inventory),
  (context: AiActionRunContext, input: LocationIdInput) => ({
    context,
    input,
  }),
);

type ApproveDetectedInput = z.output<typeof approveDetectedInventoryItemInput>;
export const approveDetectedInventoryItemWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, ApproveDetectedInput>(
    "ai.approveDetectedInventoryItem",
  )
    .call("locationId", async ({ context }, { input }) =>
      resolveOrThrow(context.db, "location", input.locationId),
    )
    .commit("approved", async ({ context }, { input, locationId }) =>
      approveDetectedInventoryItem(
        context.db,
        { ...input, locationId },
        context.actorContext,
      ),
    )
    .output(({ approved }) => approved),
  (
    context: AuthenticatedStartOperationContext,
    input: ApproveDetectedInput,
  ) => ({ context, input }),
);
export const identifyProductWorkflow = defineWorkflowOperation(
  "ai.identifyProduct",
  async (
    context: AiActionRunContext,
    input: z.output<typeof productIdentificationInput>,
  ) =>
    getAiClient().identifyProduct(input.imageUrls, {
      db: context.db,
      runId: context.runId,
      operation: "identifyProduct",
      cacheStatus: "none",
    }),
);
type UsdaSuggestionInput = z.output<typeof usdaFoodSuggestionInput>;
export const suggestUsdaFoodWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, UsdaSuggestionInput>(
    "ai.suggestUsdaFood",
  )
    .call("runId", ({ context }) =>
      ensureRun(context.db, context.actorContext, { purpose: "ai_action" }),
    )
    .call("suggestion", ({ context }, { input, runId }) =>
      suggestUsdaFood(context.usdaService, context.db, input.ingredientName, {
        runId,
      }),
    )
    .output(({ suggestion }) => suggestion),
);

type UsdaBatchInput = z.output<typeof usdaFoodSuggestionBatchInput>;
export const suggestUsdaFoodBatchWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, UsdaBatchInput>(
    "ai.suggestUsdaFoodBatch",
  )
    .call("runId", ({ context }) =>
      ensureRun(context.db, context.actorContext, { purpose: "ai_action" }),
    )
    .call("ids", async ({ context }, { input }) =>
      resolveAllOrThrow(
        context.db,
        "ingredient",
        input.ingredients.map((item) => item.id),
      ),
    )
    .call("suggestions", ({ context }, { input, ids, runId }) =>
      suggestUsdaFoodBatch(
        context.usdaService,
        context.db,
        input.ingredients.map((item, index) => ({
          id: ids[index]!,
          name: item.name,
        })),
        runId,
      ),
    )
    .output(({ suggestions }) => suggestions),
);

type IngredientMergeBatchInput = z.output<
  typeof ingredientMergeSuggestionBatchInput
>;
export const suggestIngredientMergeBatchWorkflow = bindWorkflow(
  workflow<AiActionRunContext, IngredientMergeBatchInput>(
    "ai.suggestIngredientMergeBatch",
  )
    .call("ids", async ({ context }, { input }) =>
      resolveAllOrThrow(
        context.db,
        "ingredient",
        input.ingredients.map((item) => item.id),
      ),
    )
    .call("suggestions", ({ context }, { input, ids }) =>
      suggestIngredientMergeBatch(
        context.db,
        input.ingredients.map((item, index) => ({
          id: ids[index]!,
          shortcode: item.id,
          name: item.name,
        })),
        context.runId,
      ),
    )
    .output(({ suggestions }) =>
      suggestions.map(({ source, target, ...suggestion }) => ({
        ...suggestion,
        source: { id: source.shortcode, name: source.name },
        target: target ? { id: target.shortcode, name: target.name } : null,
      })),
    ),
  (context: AiActionRunContext, input: IngredientMergeBatchInput) => ({
    context,
    input,
  }),
);
type EnrichmentPrecomputeInput = z.output<
  typeof enrichmentProposalPrecomputeInput
>;
type EnrichmentPrecomputeItem = EnrichmentPrecomputeInput["items"][number] & {
  ingredientId: IngredientId;
  runId: ImportRunId;
};
const skippedUsda: EnrichmentProposal["usda"] = {
  food: null,
  confidence: "low",
  reasoning: "",
};
const precomputeEnrichmentDefinition = defineBulkWorkflow({
  name: "ai.precomputeEnrichmentProposals",
  items: workflow<
    AuthenticatedStartOperationContext,
    EnrichmentPrecomputeInput
  >("ai.precomputeEnrichmentProposals.items")
    .call("resolved", async ({ context }, { input }) => {
      // One `ai_action` run for the whole precompute request, not one per
      // item: `resolved` runs once before the item stage fans out, so every
      // item's usda/merge lookup below carries the same run id.
      const runId = await ensureRun(context.db, context.actorContext, {
        purpose: "ai_action",
      });
      const resolved = await resolveLiveShortcodes(
        context.db,
        input.items.map((item) => item.id),
        "ingredient",
      );
      return input.items.flatMap((item) => {
        const id = resolved.get(item.id);
        return id
          ? [
              {
                ...item,
                ingredientId: parseEntityId("ingredient", id),
                runId,
              },
            ]
          : [];
      });
    })
    .output(({ resolved }) => resolved),
  item: workflow<AuthenticatedStartOperationContext, EnrichmentPrecomputeItem>(
    "ai.precomputeEnrichmentProposals.item",
  )
    .parallel("lookups", 2, {
      usda: async ({ context }, { input }) =>
        input.wantUsda
          ? suggestUsdaFood(context.usdaService, context.db, input.name, {
              ingredientId: input.ingredientId,
              runId: input.runId,
            })
          : skippedUsda,
      merge: async ({ context }, { input }) =>
        input.wantMerge
          ? suggestIngredientMerge(
              context.db,
              {
                id: input.ingredientId,
                name: input.name,
              },
              input.runId,
            )
          : null,
    })
    .output(({ input, lookups }): EnrichmentProposal => ({
      id: input.id,
      usda: lookups.usda,
      merge: lookups.merge,
    })),
  finalize: workflow<
    AuthenticatedStartOperationContext,
    BulkWorkflowSummary<EnrichmentPrecomputeItem, EnrichmentProposal>
  >("ai.precomputeEnrichmentProposals.finalize").output(({ input }) => ({
    processed: input.succeeded.length + input.failed.length,
  })),
  onItemError: "continue",
  concurrency: 5,
  progress: (proposal) => proposal,
  errorProgress: (error, item) => {
    console.error(
      `[precomputeEnrichmentProposals] ${item.name} failed:`,
      error,
    );
    return {
      id: item.id,
      usda: {
        food: null,
        confidence: "low",
        reasoning: "Lookup failed.",
      },
      merge: null,
    } satisfies EnrichmentProposal;
  },
});
export const precomputeEnrichmentProposalsWorkflow = bindBulkWorkflow(
  precomputeEnrichmentDefinition,
  (
    context: AuthenticatedStartOperationContext,
    input: EnrichmentPrecomputeInput,
    signal: AbortSignal = new AbortController().signal,
  ) => ({ context, input, signal }),
);
const locationDescriptionBackfillDefinition = defineCoordinatorStream({
  name: "ai.backfillLocationDescriptions",
  select: workflow<Database, undefined>(
    "ai.backfillLocationDescriptions.select",
  )
    .call("locationIds", async ({ context }) =>
      selectLocationDescriptionBackfill(context),
    )
    .output(({ locationIds }) => locationIds),
  commit: workflow<
    Database,
    { readonly input: undefined; readonly selection: readonly LocationId[] }
  >("ai.backfillLocationDescriptions.enqueue")
    .commit("enqueued", async ({ context }, { input: { selection } }) =>
      enqueueLocationDescriptionBackfill(context, selection),
    )
    .output(({ enqueued }) => enqueued),
  total: (locationIds) => locationIds.length,
  completionProgress: (locationIds, result) => ({
    done: result.enqueued,
    total: locationIds.length,
  }),
});
export const backfillLocationDescriptionsWorkflow = bindCoordinatorStream(
  locationDescriptionBackfillDefinition,
  (db: Database, signal?: AbortSignal) => ({
    context: db,
    input: undefined,
    signal,
  }),
);
export const listAiUsageRecentWorkflow = defineWorkflowOperation(
  "ai.usageRecent",
  async (db: Database, input: z.output<typeof aiUsageRecentInput>) =>
    listRecentAiUsage(db, input.limit),
);
export const summarizeAiUsageWorkflow = defineWorkflowOperation(
  "ai.usageSummary",
  async (db: Database, input: z.output<typeof aiUsageSummaryInput>) =>
    summarizeAiUsage(db, input.days),
);
export const suggestFieldsWorkflow = defineWorkflowOperation(
  "ai.suggestFields",
  async (
    context: AuthenticatedStartOperationContext,
    input: z.output<typeof fieldSuggestionsInput>,
  ) => {
    // A page's own `runKey` groups every target it asks about into one
    // `ai_suggest` run; no `runKey` (an older client, a one-off caller)
    // falls back to a per-call `ai_action` run.
    const runId = await ensureRun(
      context.db,
      context.actorContext,
      input.runKey
        ? { purpose: "ai_suggest", clientKey: `jev:${input.runKey}` }
        : { purpose: "ai_action" },
    );
    return suggestFields(context.db, runId, input);
  },
);
export const suggestExternalIdKindWorkflow = defineWorkflowOperation(
  "ai.suggestExternalIdKind",
  async (
    context: AuthenticatedStartOperationContext,
    input: z.output<typeof externalIdKindSuggestionInput>,
  ) => {
    const runId = await ensureRun(
      context.db,
      context.actorContext,
      input.runKey
        ? { purpose: "ai_suggest", clientKey: `jev:${input.runKey}` }
        : { purpose: "ai_action" },
    );
    return suggestExternalIdKind(input, {
      db: context.db,
      runId,
      operation: "suggestExternalIdKind",
      cacheStatus: "none",
    });
  },
);

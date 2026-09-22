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
export const describeLocationWorkflow = bindWorkflow(
  workflow<Database, LocationIdInput>("ai.describeLocation")
    .call("locationId", async ({ context }, { input }) =>
      resolveOrThrow(context, "location", input.locationId),
    )
    .commit("description", async ({ context }, { locationId }) =>
      describeLocation(context, locationId),
    )
    .output(({ description }) => description),
  (db: Database, input: LocationIdInput) => ({ context: db, input }),
);

export const detectInventoryItemsWorkflow = bindWorkflow(
  workflow<Database, LocationIdInput>("ai.detectInventoryItems")
    .call("locationId", async ({ context }, { input }) =>
      resolveOrThrow(context, "location", input.locationId),
    )
    .commit("inventory", async ({ context }, { locationId }) =>
      detectInventoryItems(context, locationId),
    )
    .output(({ inventory }) => inventory),
  (db: Database, input: LocationIdInput) => ({ context: db, input }),
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
  async (db: Database, input: z.output<typeof productIdentificationInput>) =>
    getAiClient().identifyProduct(input.imageUrls, {
      db,
      operation: "identifyProduct",
      cacheStatus: "none",
    }),
);
type UsdaSuggestionInput = z.output<typeof usdaFoodSuggestionInput>;
export const suggestUsdaFoodWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, UsdaSuggestionInput>(
    "ai.suggestUsdaFood",
  )
    .call("suggestion", ({ context }, { input }) =>
      suggestUsdaFood(context.usdaService, context.db, input.ingredientName),
    )
    .output(({ suggestion }) => suggestion),
);

type UsdaBatchInput = z.output<typeof usdaFoodSuggestionBatchInput>;
export const suggestUsdaFoodBatchWorkflow = bindWorkflow(
  workflow<AuthenticatedStartOperationContext, UsdaBatchInput>(
    "ai.suggestUsdaFoodBatch",
  )
    .call("ids", async ({ context }, { input }) =>
      resolveAllOrThrow(
        context.db,
        "ingredient",
        input.ingredients.map((item) => item.id),
      ),
    )
    .call("suggestions", ({ context }, { input, ids }) =>
      suggestUsdaFoodBatch(
        context.usdaService,
        context.db,
        input.ingredients.map((item, index) => ({
          id: ids[index]!,
          name: item.name,
        })),
      ),
    )
    .output(({ suggestions }) => suggestions),
);

type IngredientMergeBatchInput = z.output<
  typeof ingredientMergeSuggestionBatchInput
>;
export const suggestIngredientMergeBatchWorkflow = bindWorkflow(
  workflow<Database, IngredientMergeBatchInput>(
    "ai.suggestIngredientMergeBatch",
  )
    .call("ids", async ({ context }, { input }) =>
      resolveAllOrThrow(
        context,
        "ingredient",
        input.ingredients.map((item) => item.id),
      ),
    )
    .call("suggestions", ({ context }, { input, ids }) =>
      suggestIngredientMergeBatch(
        context,
        input.ingredients.map((item, index) => ({
          id: ids[index]!,
          shortcode: item.id,
          name: item.name,
        })),
      ),
    )
    .output(({ suggestions }) =>
      suggestions.map(({ source, target, ...suggestion }) => ({
        ...suggestion,
        source: { id: source.shortcode, name: source.name },
        target: target ? { id: target.shortcode, name: target.name } : null,
      })),
    ),
  (db: Database, input: IngredientMergeBatchInput) => ({ context: db, input }),
);
type EnrichmentPrecomputeInput = z.output<
  typeof enrichmentProposalPrecomputeInput
>;
type EnrichmentPrecomputeItem = EnrichmentPrecomputeInput["items"][number] & {
  ingredientId: IngredientId;
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
      const resolved = await resolveLiveShortcodes(
        context.db,
        input.items.map((item) => item.id),
        "ingredient",
      );
      return input.items.flatMap((item) => {
        const id = resolved.get(item.id);
        return id
          ? [{ ...item, ingredientId: parseEntityId("ingredient", id) }]
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
            })
          : skippedUsda,
      merge: async ({ context }, { input }) =>
        input.wantMerge
          ? suggestIngredientMerge(context.db, {
              id: input.ingredientId,
              name: input.name,
            })
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
  (db: Database, input: z.output<typeof fieldSuggestionsInput>) =>
    suggestFields(db, input),
);
export const suggestExternalIdKindWorkflow = defineWorkflowOperation(
  "ai.suggestExternalIdKind",
  (db: Database, input: z.output<typeof externalIdKindSuggestionInput>) =>
    suggestExternalIdKind(input, {
      db,
      operation: "suggestExternalIdKind",
      cacheStatus: "none",
    }),
);

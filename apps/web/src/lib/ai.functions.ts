import {
  aiBackfillLocationDescriptionsEventSchema,
  aiEnrichmentProposalEventSchema,
  aiLocationIdInput,
  aiUsageRecentInput,
  aiUsageRecentOut,
  aiUsageSummaryInput,
  aiUsageSummaryOut,
  approveDetectedInventoryItemInput,
  approveDetectedInventoryItemOut,
  categoryAuditSchema,
  categorySuggestionInput,
  categorySuggestionSchema,
  detectedInventorySchema,
  type enrichmentProposalPrecomputeInput,
  ingredientMergeSuggestionBatchInput,
  ingredientMergeSuggestionBatchOut,
  locationDescriptionSchema,
  locationSuggestionInput,
  locationSuggestionSchema,
  locationTypeSuggestionInput,
  locationTypeSuggestionSchema,
  parsedSearchSchema,
  parseSearchInput,
  productIdentificationInput,
  productIdentificationSchema,
  usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionBatchOut,
  usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
import type { z } from "zod";
import { z as zod } from "zod";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";
import { openWorkflowStream } from "~/lib/workflow-stream";

export const ai = defineOperationDomain("ai", {
  suggestCategory: query({
    input: categorySuggestionInput,
    output: categorySuggestionSchema,
    tags: [["ai", "suggestCategory"]],
  }),
  suggestLocationType: query({
    input: locationTypeSuggestionInput,
    output: locationTypeSuggestionSchema,
    tags: [["ai", "suggestLocationType"]],
  }),
  suggestLocation: query({
    input: locationSuggestionInput,
    output: locationSuggestionSchema,
    tags: [["ai", "suggestLocation"]],
  }),
  describeLocation: mutation({
    input: aiLocationIdInput,
    output: locationDescriptionSchema,
    invalidates: [["location"]],
  }),
  detectInventoryItems: mutation({
    input: aiLocationIdInput,
    output: detectedInventorySchema,
    invalidates: [["inventory"]],
  }),
  approveDetectedInventoryItem: mutation({
    input: approveDetectedInventoryItemInput,
    output: approveDetectedInventoryItemOut,
    invalidates: [["inventory"], ["product"]],
  }),
  identifyProduct: mutation({
    input: productIdentificationInput,
    output: productIdentificationSchema,
    invalidates: [],
  }),
  suggestUsdaFood: mutation({
    input: usdaFoodSuggestionInput,
    output: usdaFoodSuggestionOut,
    invalidates: [],
  }),
  suggestUsdaFoodBatch: mutation({
    input: usdaFoodSuggestionBatchInput,
    output: usdaFoodSuggestionBatchOut,
    invalidates: [["ingredient"]],
  }),
  suggestIngredientMergeBatch: mutation({
    input: ingredientMergeSuggestionBatchInput,
    output: ingredientMergeSuggestionBatchOut,
    invalidates: [["ingredient"]],
  }),
  parseSearch: mutation({
    input: parseSearchInput,
    output: parsedSearchSchema,
    invalidates: [],
  }),
  usageRecent: query({
    input: aiUsageRecentInput,
    output: aiUsageRecentOut,
    tags: [["ai", "usage"]],
  }),
  usageSummary: query({
    input: aiUsageSummaryInput,
    output: aiUsageSummaryOut,
    tags: [["ai", "usage"]],
  }),
  auditCategories: mutation({
    input: zod.undefined(),
    output: categoryAuditSchema,
    invalidates: [["product"]],
  }),
});

export const backfillLocationDescriptionsStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "ai.backfillLocationDescriptions",
    kind: "mutation",
    url: "/api/ai-stream/backfill-location-descriptions",
    input: undefined,
    eventSchema: aiBackfillLocationDescriptionsEventSchema,
    signal,
  });
export const precomputeEnrichmentProposalsStream = (
  input: z.input<typeof enrichmentProposalPrecomputeInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "ai.precomputeEnrichmentProposals",
    kind: "mutation",
    url: "/api/ai-stream/precompute-enrichment-proposals",
    input,
    eventSchema: aiEnrichmentProposalEventSchema,
    signal,
  });

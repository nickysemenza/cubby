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
  enrichmentProposalPrecomputeInput,
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

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
  subscription,
} from "~/integrations/tanstack-query/operation-catalog";

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
    invalidates: ripple.location,
  }),
  detectInventoryItems: mutation({
    input: aiLocationIdInput,
    output: detectedInventorySchema,
    invalidates: ripple.inventory,
  }),
  approveDetectedInventoryItem: mutation({
    input: approveDetectedInventoryItemInput,
    output: approveDetectedInventoryItemOut,
    invalidates: ripple.inventory,
  }),
  identifyProduct: mutation({
    input: productIdentificationInput,
    output: productIdentificationSchema,
    invalidates: ripple.none,
  }),
  suggestUsdaFood: mutation({
    input: usdaFoodSuggestionInput,
    output: usdaFoodSuggestionOut,
    invalidates: ripple.none,
  }),
  suggestUsdaFoodBatch: mutation({
    input: usdaFoodSuggestionBatchInput,
    output: usdaFoodSuggestionBatchOut,
    invalidates: ripple.ingredient,
  }),
  suggestIngredientMergeBatch: mutation({
    input: ingredientMergeSuggestionBatchInput,
    output: ingredientMergeSuggestionBatchOut,
    invalidates: ripple.ingredient,
  }),
  parseSearch: mutation({
    input: parseSearchInput,
    output: parsedSearchSchema,
    invalidates: ripple.none,
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
    invalidates: ripple.product,
  }),
});

export const aiStreams = defineOperationDomain("ai", {
  backfillLocationDescriptions: subscription({
    input: zod.undefined(),
    event: aiBackfillLocationDescriptionsEventSchema,
  }),
  precomputeEnrichmentProposals: subscription({
    input: enrichmentProposalPrecomputeInput,
    event: aiEnrichmentProposalEventSchema,
  }),
});

export const backfillLocationDescriptionsStream = (signal?: AbortSignal) =>
  aiStreams.backfillLocationDescriptions.open(undefined, { signal });
export const precomputeEnrichmentProposalsStream = (
  input: z.input<typeof enrichmentProposalPrecomputeInput>,
  signal?: AbortSignal,
) => aiStreams.precomputeEnrichmentProposals.open(input, { signal });

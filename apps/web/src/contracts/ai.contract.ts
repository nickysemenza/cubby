import {
  aiBackfillLocationDescriptionsEventSchema,
  aiCacheMetadataSchema,
  aiEnrichmentProposalEventSchema,
  aiLocationIdInput,
  aiUsageRecentInput,
  aiUsageRecentOut,
  aiUsageSummaryInput,
  aiUsageSummaryOut,
  approveDetectedInventoryItemInput,
  approveDetectedInventoryItemOut,
  detectedInventorySchema,
  enrichmentProposalPrecomputeInput,
  fieldSuggestionsInput,
  fieldSuggestionsOut,
  ingredientMergeSuggestionBatchInput,
  ingredientMergeSuggestionBatchOut,
  locationDescriptionSchema,
  productIdentificationInput,
  productIdentificationSchema,
  usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionBatchOut,
  usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
import { z as zod } from "zod";

import {
  defineContract,
  mutation,
  query,
  subscription,
} from "~/contracts/define";

/**
 * The description and the detection carry their provenance to the client so
 * the surfaces can label it: which model read the photos, when, and whether
 * this was a fresh read or a replay of a stored analysis.
 *
 * Composed here rather than in `@cubby/schemas` because that package holds
 * shared field maps rather than zod combinators, and because provenance is a
 * presentation concern of these two read paths, not part of what the model is
 * asked to produce (`locationDescriptionSchema` is also the AiAnalysis row
 * schema — widening it there would change what gets persisted).
 */
const locationDescriptionWithProvenance = locationDescriptionSchema.extend({
  cache: aiCacheMetadataSchema,
  analyzedAt: zod.coerce.date(),
});

const detectedInventoryWithProvenance = detectedInventorySchema.extend({
  analyzedAt: zod.coerce.date(),
});

export const aiContract = defineContract("ai", {
  describeLocation: mutation({
    input: aiLocationIdInput,
    output: locationDescriptionWithProvenance,
  }),
  detectInventoryItems: mutation({
    input: aiLocationIdInput,
    output: detectedInventoryWithProvenance,
  }),
  approveDetectedInventoryItem: mutation({
    input: approveDetectedInventoryItemInput,
    output: approveDetectedInventoryItemOut,
  }),
  identifyProduct: mutation({
    input: productIdentificationInput,
    output: productIdentificationSchema,
  }),
  suggestUsdaFood: mutation({
    input: usdaFoodSuggestionInput,
    output: usdaFoodSuggestionOut,
  }),
  suggestUsdaFoodBatch: mutation({
    input: usdaFoodSuggestionBatchInput,
    output: usdaFoodSuggestionBatchOut,
  }),
  suggestIngredientMergeBatch: mutation({
    input: ingredientMergeSuggestionBatchInput,
    output: ingredientMergeSuggestionBatchOut,
  }),
  // Nested `basis` can't ride the HTTP GET projection (precedent:
  // `entity-list.contract.ts`'s `list`) — `.queryOptions()` still works.
  suggestFields: query({
    input: fieldSuggestionsInput,
    output: fieldSuggestionsOut,
    http: false,
  }),
  usageRecent: query({
    input: aiUsageRecentInput,
    output: aiUsageRecentOut,
  }),
  usageSummary: query({
    input: aiUsageSummaryInput,
    output: aiUsageSummaryOut,
  }),
});

export const aiStreamsContract = defineContract("ai", {
  backfillLocationDescriptions: subscription({
    input: zod.undefined(),
    event: aiBackfillLocationDescriptionsEventSchema,
  }),
  precomputeEnrichmentProposals: subscription({
    input: enrichmentProposalPrecomputeInput,
    event: aiEnrichmentProposalEventSchema,
  }),
});

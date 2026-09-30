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
  externalIdKindSuggestionInput,
  financeCategoryApplyInput,
  financeCategoryApplyOut,
  fieldSuggestionsInput,
  fieldSuggestionsOut,
  ingredientMergeSuggestionBatchInput,
  ingredientMergeSuggestionBatchOut,
  locationDescriptionSchema,
  productIdentificationInput,
  productIdentificationSchema,
  suggestExternalIdKindOut,
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
    invalidates: ["location"],
  }),
  detectInventoryItems: mutation({
    input: aiLocationIdInput,
    output: detectedInventoryWithProvenance,
    invalidates: ["inventory"],
  }),
  approveDetectedInventoryItem: mutation({
    input: approveDetectedInventoryItemInput,
    output: approveDetectedInventoryItemOut,
    invalidates: ["inventory"],
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
    invalidates: ["ingredient"],
  }),
  suggestIngredientMergeBatch: mutation({
    input: ingredientMergeSuggestionBatchInput,
    output: ingredientMergeSuggestionBatchOut,
    invalidates: ["ingredient"],
  }),
  // Nested `basis` can't ride the HTTP GET projection (precedent:
  // `entity-list.contract.ts`'s `list`) — `.queryOptions()` still works.
  // AI and externally hydrated food reads own authoritative database helpers.
  applyFinanceCategorySuggestion: mutation({
    input: financeCategoryApplyInput,
    output: financeCategoryApplyOut,
    invalidates: ["financialTransaction", "purchase", "expense"],
  }),
  suggestFields: query({
    readPolicy: "strong",
    input: fieldSuggestionsInput,
    output: fieldSuggestionsOut,
    http: false,
    cache: { profile: "stable" },
  }),
  // Same reason as `suggestFields`: a per-row hint, not a public HTTP query.
  suggestExternalIdKind: query({
    readPolicy: "strong",
    input: externalIdKindSuggestionInput,
    output: suggestExternalIdKindOut,
    http: false,
    cache: { profile: "stable" },
  }),
  usageRecent: query({
    input: aiUsageRecentInput,
    output: aiUsageRecentOut,
    cache: { tags: [["ai", "usage"]] },
  }),
  usageSummary: query({
    input: aiUsageSummaryInput,
    output: aiUsageSummaryOut,
    cache: { tags: [["ai", "usage"]] },
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

import {
  aiBackfillLocationDescriptionsEventSchema,
  aiCacheMetadataSchema,
  aiEnrichmentProposalEventSchema,
  aiLocationIdInput,
  aiUsageFilterOptionsOut,
  aiUsageRecentInput,
  aiUsageRecentOut,
  aiUsageSummaryInput,
  aiUsageSummaryOut,
  approveDetectedInventoryItemInput,
  approveDetectedInventoryItemOut,
  detectedInventorySchema,
  detectInventoryItemsInput,
  enrichmentProposalPrecomputeInput,
  externalIdKindSuggestionInput,
  financeCategoryApplyInput,
  financeCategoryApplyOut,
  fieldSuggestionsInput,
  fieldSuggestionsOut,
  fieldSuggestionsReviewOut,
  fieldSuggestionMissInput,
  fieldSuggestionMissOut,
  suggestionMissesOut,
  suggestionReviewActionInput,
  suggestionReviewActionOut,
  suggestionReviewBatchInput,
  suggestionReviewBatchOut,
  suggestionReviewListInput,
  suggestionReviewListOut,
  suggestionReviewRejectInput,
  suggestionSweepControlInput,
  suggestionSweepStartInput,
  suggestionSweepStartOut,
  suggestionSweepStatusOut,
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
  /** What the location said before this run: the left side of the review. */
  previousDescription: zod.string().nullable(),
});

const detectedInventoryWithProvenance = detectedInventorySchema.extend({
  analyzedAt: zod.coerce.date(),
});

export const aiContract = defineContract("ai", {
  describeLocation: mutation({
    mcp: { omit: "model_assist" },
    native: "Analyze a location's photos from its AI description section",
    input: aiLocationIdInput,
    output: locationDescriptionWithProvenance,
    invalidates: ["location"],
  }),
  detectInventoryItems: mutation({
    mcp: { omit: "model_assist" },
    input: detectInventoryItemsInput,
    output: detectedInventoryWithProvenance,
    invalidates: ["inventory"],
    native: "Detect items in a just-added location photo",
  }),
  approveDetectedInventoryItem: mutation({
    mcp: { omit: "human_approval" },
    input: approveDetectedInventoryItemInput,
    output: approveDetectedInventoryItemOut,
    invalidates: ["inventory"],
    native: "Approve one detected item into a location's inventory",
  }),
  identifyProduct: mutation({
    mcp: { omit: "model_assist" },
    input: productIdentificationInput,
    output: productIdentificationSchema,
    invalidates: [],
  }),
  suggestUsdaFood: mutation({
    mcp: {
      omit: "model_assist",
      note: "Agents rank with usda_food.suggest_for_product",
    },
    input: usdaFoodSuggestionInput,
    output: usdaFoodSuggestionOut,
    invalidates: [],
  }),
  suggestUsdaFoodBatch: mutation({
    mcp: { omit: "model_assist" },
    input: usdaFoodSuggestionBatchInput,
    output: usdaFoodSuggestionBatchOut,
    invalidates: ["ingredient"],
  }),
  suggestIngredientMergeBatch: mutation({
    mcp: { omit: "model_assist" },
    input: ingredientMergeSuggestionBatchInput,
    output: ingredientMergeSuggestionBatchOut,
    invalidates: ["ingredient"],
  }),
  // Nested `basis` can't ride the HTTP GET projection (precedent:
  // `entity-list.contract.ts`'s `list`) — `.queryOptions()` still works.
  // AI and externally hydrated food reads own authoritative database helpers.
  applyFinanceCategorySuggestion: mutation({
    mcp: {
      omit: "human_approval",
      note: "Applies suggestions a person reviewed; agents classify through spending_classification_write",
    },
    input: financeCategoryApplyInput,
    output: financeCategoryApplyOut,
    invalidates: [
      "financialTransaction",
      "purchase",
      "expense",
      "vendor",
      "product",
    ],
    native: "Reviewed saved finance category suggestions",
  }),
  suggestFields: query({
    mcp: { omit: "model_assist" },
    readPolicy: "strong",
    input: fieldSuggestionsInput,
    output: fieldSuggestionsOut,
    http: false,
    cache: { profile: "stable" },
  }),
  suggestFieldsReview: query({
    mcp: { omit: "model_assist" },
    readPolicy: "strong",
    input: fieldSuggestionsInput,
    output: fieldSuggestionsReviewOut,
    transport: "post",
    native: "Reviewed manifest field suggestions with nullable proposals",
    cache: { profile: "stable" },
  }),
  listSuggestionReviewQueue: query({
    mcp: { omit: "operator_maintenance" },
    input: suggestionReviewListInput,
    output: suggestionReviewListOut,
    readPolicy: "strong",
    transport: "post",
    cache: { profile: "stable" },
  }),
  listSuggestionMisses: query({
    mcp: { omit: "operator_maintenance" },
    input: zod.object({ runId: zod.string().uuid().optional() }),
    output: suggestionMissesOut,
    readPolicy: "strong",
    cache: { profile: "stable" },
  }),
  acceptSuggestion: mutation({
    mcp: { omit: "human_approval" },
    input: suggestionReviewActionInput,
    output: suggestionReviewActionOut,
    invalidates: ["product", "expense", "purchase", "vendor"],
  }),
  acceptSuggestions: mutation({
    mcp: { omit: "human_approval" },
    input: suggestionReviewBatchInput,
    output: suggestionReviewBatchOut,
    invalidates: ["product", "expense", "purchase", "vendor"],
  }),
  rejectSuggestion: mutation({
    mcp: { omit: "human_approval" },
    input: suggestionReviewRejectInput,
    output: suggestionReviewActionOut,
    invalidates: ["product", "expense", "purchase", "vendor"],
  }),
  recordFieldSuggestionMiss: mutation({
    mcp: { omit: "human_approval" },
    input: fieldSuggestionMissInput,
    output: fieldSuggestionMissOut,
    invalidates: [],
  }),
  startSuggestionSweep: mutation({
    mcp: { omit: "operator_maintenance" },
    input: suggestionSweepStartInput,
    output: suggestionSweepStartOut,
    invalidates: [],
  }),
  pauseSuggestionSweep: mutation({
    mcp: { omit: "operator_maintenance" },
    input: suggestionSweepControlInput,
    output: zod.object({ paused: zod.literal(true) }),
    invalidates: [],
  }),
  resumeSuggestionSweep: mutation({
    mcp: { omit: "operator_maintenance" },
    input: suggestionSweepControlInput,
    output: suggestionSweepStartOut,
    invalidates: [],
  }),
  latestSuggestionSweepStatus: query({
    mcp: { omit: "operator_maintenance" },
    input: zod.undefined(),
    output: suggestionSweepStatusOut,
    cache: { profile: "stable" },
  }),
  // Same reason as `suggestFields`: a per-row hint, not a public HTTP query.
  suggestExternalIdKind: query({
    mcp: { omit: "model_assist" },
    readPolicy: "strong",
    input: externalIdKindSuggestionInput,
    output: suggestExternalIdKindOut,
    http: false,
    cache: { profile: "stable" },
  }),
  usageFilterOptions: query({
    mcp: { omit: "operator_maintenance", note: "AI spend telemetry" },
    input: zod.undefined(),
    output: aiUsageFilterOptionsOut,
    cache: { tags: [["ai", "usage"]] },
  }),
  usageRecent: query({
    mcp: { omit: "operator_maintenance", note: "AI spend telemetry" },
    input: aiUsageRecentInput,
    output: aiUsageRecentOut,
    // Nested `filters` has no GET query projection.
    transport: "post",
    cache: { tags: [["ai", "usage"]] },
  }),
  usageSummary: query({
    mcp: { omit: "operator_maintenance", note: "AI spend telemetry" },
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

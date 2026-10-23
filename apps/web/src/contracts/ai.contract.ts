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
  fieldSuggestionsBatchInput,
  fieldSuggestionsBatchOut,
  fieldSuggestionsReviewOut,
  settledSuggestionQuestionsInput,
  settledSuggestionQuestionsOut,
  decisionCatalogOut,
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
import {
  aiFundingStatus,
  aiBudgetSettings,
} from "@cubby/schemas/mail-import-settings";
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

export const aiContract = defineContract(
  "ai",
  {
    describeLocation: mutation({
      input: aiLocationIdInput,
      output: locationDescriptionWithProvenance,
      invalidates: ["location"],
    }),
    detectInventoryItems: mutation({
      input: detectInventoryItemsInput,
      output: detectedInventoryWithProvenance,
      invalidates: ["inventory"],
    }),
    approveDetectedInventoryItem: mutation({
      exposure: "capability",
      description:
        "Stock one item detected in a location photo, reusing productId or creating its Product.",
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
      note: "Agents rank with usda_food.suggest_for_product",
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
    // AI and externally hydrated food reads own authoritative database helpers.
    applyFinanceCategorySuggestion: mutation({
      exposure: "capability",
      description:
        "Apply one reviewed finance category suggestion with its fingerprint; refuses when the target changed since review.",
      input: financeCategoryApplyInput,
      output: financeCategoryApplyOut,
      invalidates: [
        "financialTransaction",
        "purchase",
        "expense",
        "vendor",
        "product",
      ],
    }),
    suggestFields: query({
      exposure: "capability",
      description:
        "Decision-model field suggestions for a record or draft (`targets`, `basis`); a spending field also returns financeReview, whose fingerprint ai.apply_finance_category_suggestion takes. Mint one runKey uuid per session and reuse it for entity.record_suggestion_miss. decisionModel pins Jev (typesafe/jev) or Clef (@cf/cloudflare/clef) to replay one record through each trial model.",
      modelBacked: true,
      readPolicy: "strong",
      input: fieldSuggestionsInput,
      output: fieldSuggestionsOut,
      cache: { profile: "stable" },
      queryKeyOmit: ["runKey"],
    }),
    suggestFieldsBatch: query({
      readPolicy: "strong",
      input: fieldSuggestionsBatchInput,
      output: fieldSuggestionsBatchOut,
      cache: { profile: "stable" },
    }),
    suggestFieldsReview: query({
      note: "The same suggestions as a list for Swift",
      readPolicy: "strong",
      input: fieldSuggestionsInput,
      output: fieldSuggestionsReviewOut,
      cache: { profile: "stable" },
      queryKeyOmit: ["runKey"],
    }),
    settledSuggestionQuestions: query({
      note: "List pages skip re-asking declined suggestion questions",
      input: settledSuggestionQuestionsInput,
      output: settledSuggestionQuestionsOut,
      readPolicy: "strong",
      // List pages batch this read and cache each question separately, tagged
      // with the entity kinds its decision reads (`record-suggestions.tsx`).
      cache: { profile: "stable", tags: [["ai", "settledSuggestionQuestion"]] },
    }),
    decisionCatalog: query({
      note: "The /ai Decisions tab; agents replay decisions through suggest_fields",
      input: zod.undefined(),
      output: decisionCatalogOut,
      cache: { profile: "stable" },
    }),
    startSuggestionSweep: mutation({
      exposure: "capability",
      description:
        "Start a bounded background suggestion sweep for the requested scope. It enqueues model-backed proposal work; inspect progress with latest_suggestion_sweep_status and review proposals in suggestions_read.list.",
      input: suggestionSweepStartInput,
      output: suggestionSweepStartOut,
      invalidates: [],
    }),
    pauseSuggestionSweep: mutation({
      exposure: "capability",
      description:
        "Pause the active suggestion sweep. Existing progress and proposals remain recorded; inspect the result with latest_suggestion_sweep_status.",
      command: { label: "Pause suggestions", confirmation: null },
      input: suggestionSweepControlInput,
      output: zod.object({ paused: zod.literal(true) }),
      invalidates: [],
    }),
    resumeSuggestionSweep: mutation({
      exposure: "capability",
      description:
        "Resume a paused suggestion sweep from its saved checkpoint. Inspect progress with latest_suggestion_sweep_status and review proposals in suggestions_read.list.",
      command: { label: "Resume suggestions", confirmation: null },
      input: suggestionSweepControlInput,
      output: suggestionSweepStartOut,
      invalidates: [],
    }),
    latestSuggestionSweepStatus: query({
      exposure: "capability",
      description:
        "Read the latest suggestion sweep status and progress. This does not start or resume work.",
      input: zod.undefined(),
      output: suggestionSweepStatusOut,
      cache: { profile: "stable" },
    }),
    suggestExternalIdKind: query({
      readPolicy: "strong",
      input: externalIdKindSuggestionInput,
      output: suggestExternalIdKindOut,
      cache: { profile: "stable" },
      queryKeyOmit: ["runKey"],
    }),
    usageFilterOptions: query({
      exposure: "capability",
      note: "AI spend telemetry",
      description:
        "Read the available filters for AI usage telemetry. Use these values to narrow usage_recent or usage_summary.",
      input: zod.undefined(),
      output: aiUsageFilterOptionsOut,
      cache: { tags: [["ai", "usage"]] },
    }),
    usageRecent: query({
      exposure: "capability",
      note: "AI spend telemetry",
      description:
        "Read recent AI usage records for the requested filters. This is telemetry, not a source of authoritative household decisions.",
      input: aiUsageRecentInput,
      output: aiUsageRecentOut,
      // Nested `filters` has no GET query projection.
      cache: { tags: [["ai", "usage"]] },
    }),
    usageSummary: query({
      exposure: "capability",
      note: "AI spend telemetry",
      description:
        "Summarize AI usage and cost over the requested filters and time window. Use usage_recent to inspect individual calls.",
      input: aiUsageSummaryInput,
      output: aiUsageSummaryOut,
      cache: { tags: [["ai", "usage"]] },
    }),
  },
  { exposure: "view" },
);

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

/** Household-wide frontier AI funding (ADR 0017), shared by every feature. */
export const aiFundingContract = defineContract(
  "aiFunding",
  {
    status: query({
      description:
        "The current six-hour window's funding: credit (Claude subscriber credit spent at standard API cost of limitUsd, default $5, with state available or refused: a recorded Anthropic refusal such as a Console spend limit, skipped until `until` with one probe per window, and its raw `reason`), paid (charged cost of $1) and plan (ChatGPT plan available, paused until a quota reset, disconnected or needing reauthorization, with the raw reason). Frontier calls use credit, then the plan, then paid only where allowed; background work waits instead of paying. Change it with ai_funding.",
      input: zod.strictObject({}),
      output: aiFundingStatus,
      // Spend and refusals move with model calls; Run writes refresh it.
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    setCreditBudget: mutation({
      description:
        "Set household AI budgets per six-hour window: creditLimitUsd (Claude standard API cost), planLimitUsd (ChatGPT standard API cost, default $2), and paidLimitUsd (charged cost, default $1). Background work moves from credit to plan, then paid within these limits. Also clears a recorded Claude credit refusal, and work paused for free capacity retries now. Returns ai_funding_read.status.",
      input: aiBudgetSettings,
      output: aiFundingStatus,
      invalidates: ["runOnly"],
    }),
    resetCreditRefusal: mutation({
      description:
        'Clear a recorded Claude credit refusal ("Retry Claude credit now") so the next frontier call tries Claude credit again, e.g. after raising the Console spend limit; work paused for free capacity retries now. A still-refusing Console records the refusal again on that call. Returns ai_funding_read.status.',
      input: zod.strictObject({}),
      output: aiFundingStatus,
      invalidates: ["runOnly"],
    }),
  },
  { exposure: "capability" },
);

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
  settledSuggestionQuestionsInput,
  settledSuggestionQuestionsOut,
  decisionCatalogOut,
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
  fundingRefusalSource,
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
      note: "Agents rank with product_enrichment_read.suggest_for_product",
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
      input: fieldSuggestionsInput,
      output: fieldSuggestionsOut,
    }),
    settledSuggestionQuestions: query({
      note: "List pages skip re-asking declined suggestion questions",
      input: settledSuggestionQuestionsInput,
      output: settledSuggestionQuestionsOut,
      // List pages batch this read and cache each question separately, tagged
      // with the entity kinds its decision reads (`record-suggestions.tsx`).
      cache: { tags: [["ai", "settledSuggestionQuestion"]] },
    }),
    decisionCatalog: query({
      note: "The /ai Decisions tab; agents replay decisions through suggest_fields",
      input: zod.undefined(),
      output: decisionCatalogOut,
    }),
    automaticWork: query({
      exposure: "capability",
      description:
        "Whether a member stopped automatic AI work (refresh and routine connection discovery), and when.",
      input: zod.strictObject({}),
      output: zod.object({ stoppedAt: zod.iso.datetime().nullable() }),
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    stopAutomaticWork: mutation({
      exposure: "capability",
      description:
        "Stop automatic AI work until a member resumes it: discovery admits nothing, owed evaluations are parked, and an answer already in flight is not published. Work a member or agent session owns is unaffected.",
      command: { label: "Stop automatic AI work", confirmation: null },
      input: zod.strictObject({}),
      output: zod.object({ parked: zod.number().int().nonnegative() }),
      invalidates: ["runOnly"],
    }),
    resumeAutomaticWork: mutation({
      exposure: "capability",
      description:
        "Resume automatic AI work a member stopped, including everything the Stop parked.",
      command: { label: "Resume automatic AI work", confirmation: null },
      input: zod.strictObject({}),
      output: zod.object({ resumed: zod.number().int().nonnegative() }),
      invalidates: ["runOnly"],
    }),
    suggestExternalIdKind: query({
      input: externalIdKindSuggestionInput,
      output: suggestExternalIdKindOut,
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

/** Household-wide frontier AI funding (ADR 0027), shared by every feature. */
export const aiFundingContract = defineContract(
  "aiFunding",
  {
    status: query({
      description:
        "The current six-hour window's funding per source: credit (Claude subscriber credit spent at standard API cost, with no window budget, and state available or refused: a recorded Anthropic refusal such as a spent balance or Console spend limit, skipped until `until` with one probe per window, and its raw `reason`), openaiCredit (OpenAI API credit, the same shape), plan (ChatGPT plan standard-cost spend of the stored limitUsd, $2 when never set, available, paused until a quota reset, disconnected or needing reauthorization, with the raw reason) and paid (charged cost of the stored limitUsd, $1 when never set, with state refused when the AI Gateway reported an empty balance, until the window ends, with its raw reason). Each source's `availability` is the server's verdict for background work: usable, or a blocker (budget_spent, provider_refused, plan_limit, disconnected, needs_reauthorization, gateway_balance_empty) with `until` when it recovers by itself. Frontier calls use Claude credit, OpenAI credit, then the plan, then paid only where allowed; credits run until their provider refuses, and background work uses the plan and paid within their window budgets, then waits. Change it with ai_funding.",
      input: zod.strictObject({}),
      output: aiFundingStatus,
      // Spend and refusals move with model calls; Run writes refresh it.
      cache: { tags: [["run"]], profile: "live-status" },
    }),
    setBudget: mutation({
      description:
        "Set household AI budgets per six-hour window: planLimitUsd (ChatGPT plan standard API cost, default $2; the plan's quota is shared with the members' own use) and paidLimitUsd (charged cost, default $1). Provider credits have no window budget. Work paused for funding retries now. Returns ai_funding_read.status.",
      input: aiBudgetSettings,
      output: aiFundingStatus,
      invalidates: ["runOnly"],
    }),
    resetFundingRefusal: mutation({
      description:
        "Clear a recorded funding refusal so the next frontier call tries that source again, e.g. after adding Claude or OpenAI credit or AI Gateway balance: source credit, openaiCredit or paid, or every source when omitted. Work paused for funding retries now; a still-refusing provider records the refusal again on that call. Returns ai_funding_read.status.",
      input: zod.strictObject({ source: fundingRefusalSource.optional() }),
      output: aiFundingStatus,
      invalidates: ["runOnly"],
    }),
  },
  { exposure: "capability" },
);

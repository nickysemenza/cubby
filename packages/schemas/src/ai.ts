import { vendorSpendingProfile } from "./spending-classification";
import { z } from "zod";
import { fieldResolutionsSchema } from "./field-resolution";
import { mutationSideEffectsSchema } from "./mutation-side-effects";
import { shortcodeEntities } from "./entity-manifest";
import { moneyNullable } from "./money";
import {
  runShortcode,
  ingredientShortcode,
  imageShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
  productCategoryShortcode,
  spendingCategoryShortcode,
} from "./identifiers";
import { productCategory } from "./product-fields";
import {
  aiUsageTransport,
  aiUsageTransportValues,
  type AiUsageTransport,
} from "./telemetry";
import { usdaFoodListRow } from "./usda";

// Confidence level values - single source of truth
export const confidenceValues = ["high", "medium", "low"] as const;

export const confidence = z.enum(confidenceValues);

export type Confidence = z.infer<typeof confidence>;

// One shared result shape for the generic "AI selection" helper
// (`server/ai/selection.ts`): given a subject and a rendered shortlist, the
// model names the chosen candidate's id (or null when none fits) plus its
// confidence and reasoning. Every `runAiSelection` consumer (location
// suggestion, USDA match, ingredient merge) shares this one schema instead of
// each declaring its own near-identical shape.
export const aiSelectionResultSchema = z.object({
  selectedId: z.string().nullable(),
  confidence: confidence,
  reasoning: z.string(),
});
export type AiSelectionResult = z.infer<typeof aiSelectionResultSchema>;

export const aiLocationIdInput = z.object({
  locationId: locationShortcode,
});

export const MAX_DETECTION_IMAGE_IDS = 5;

export const detectInventoryItemsInput = aiLocationIdInput.extend({
  /** Analyze only these attached images (a native photo just committed); omitted means the location's first images. */
  imageIds: z
    .array(imageShortcode)
    .min(1)
    .max(MAX_DETECTION_IMAGE_IDS)
    .optional(),
});

export const locationDescriptionSchema = z.object({
  description: z.string(),
  confidence: confidence,
});
export type LocationDescription = z.infer<typeof locationDescriptionSchema>;

export const aiAnalysisEntityKind = z.enum([
  "image",
  "location",
  "product",
  "recipe",
  "global",
]);
export type AiAnalysisEntityKind = z.infer<typeof aiAnalysisEntityKind>;

export const aiCacheStatus = z.enum(["hit", "miss"]);
export type AiCacheStatus = z.infer<typeof aiCacheStatus>;

export const aiCacheMetadataSchema = z.object({
  status: aiCacheStatus,
  feature: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  inputFingerprint: z.string(),
});
export type AiCacheMetadata = z.infer<typeof aiCacheMetadataSchema>;

const detectedInventoryItemFields = {
  name: z.string(),
  manufacturer: z.string(),
  // Anthropic structured output rejects JSON Schema's `exclusiveMinimum`, which
  // Zod emits for `.positive()`. Keep this as a plain number for provider schema
  // compatibility; the approval path clamps invalid model output before writing
  // inventory.
  estimatedQuantity: z.number(),
  unit: z.string(),
  confidence: confidence,
  evidence: z.string(),
  isMisc: z.boolean(),
};

export const detectedInventoryItemSchema = z.object(
  detectedInventoryItemFields,
);
export type DetectedInventoryItem = z.infer<typeof detectedInventoryItemSchema>;

export const MAX_DETECTED_INVENTORY_ITEMS = 20;

export const detectedProductMatchSchema = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
});
export type DetectedProductMatch = z.infer<typeof detectedProductMatchSchema>;

export const detectedItemSchema = z.object({
  ...detectedInventoryItemFields,
  matchedProduct: detectedProductMatchSchema.nullable(),
});
export type DetectedItem = z.infer<typeof detectedItemSchema>;

export const detectedInventoryAiResultSchema = z.object({
  items: z.array(detectedInventoryItemSchema).max(MAX_DETECTED_INVENTORY_ITEMS),
  summary: z.string(),
});
export type DetectedInventoryAiResult = z.infer<
  typeof detectedInventoryAiResultSchema
>;

export const detectedInventorySchema = z.object({
  items: z.array(detectedItemSchema),
  summary: z.string(),
  cache: aiCacheMetadataSchema,
});
export type DetectedInventory = z.infer<typeof detectedInventorySchema>;

export const approveDetectedInventoryItemInput = z.object({
  locationId: locationShortcode,
  item: detectedInventoryItemSchema,
  productId: productShortcode.nullable().optional(),
});

export const approveDetectedInventoryItemOut = z.object({
  inventoryId: inventoryShortcode,
  productId: productShortcode,
  productName: z.string(),
  createdProduct: z.boolean(),
  sideEffects: mutationSideEffectsSchema,
});

export type ApproveDetectedInventoryItemInput = z.infer<
  typeof approveDetectedInventoryItemInput
>;
export type ApproveDetectedInventoryItemOut = z.infer<
  typeof approveDetectedInventoryItemOut
>;

export const productIdentificationSchema = z.object({
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  confidence,
  reasoning: z.string(),
});
export type ProductIdentification = z.infer<typeof productIdentificationSchema>;

export const productIdentificationInput = z.object({
  imageUrls: z.array(z.string().url()).min(1).max(5),
});

export const usdaFoodSuggestionInput = z.object({
  ingredientName: z.string().min(1),
});

const usdaFoodSuggestionFields = {
  food: usdaFoodListRow.nullable(),
  confidence,
  reasoning: z.string(),
};

export const usdaFoodSuggestionOut = z.object(usdaFoodSuggestionFields);

export const usdaFoodSuggestionBatchInput = z.object({
  ingredients: z
    .array(z.object({ id: ingredientShortcode, name: z.string().min(1) }))
    .min(1)
    .max(20),
});

export const usdaFoodSuggestionBatchOut = z.array(
  z.object({ ...usdaFoodSuggestionFields, name: z.string() }),
);

export const ingredientMergeSuggestionItem = z.object({
  id: ingredientShortcode,
  name: z.string().min(1),
});

export const ingredientMergeSuggestionBatchInput = z.object({
  ingredients: z.array(ingredientMergeSuggestionItem).min(1).max(20),
});

const ingredientMergeSuggestionRef = z.object({
  id: ingredientShortcode,
  name: z.string(),
});

export const ingredientMergeSuggestionBatchOut = z.array(
  z.object({
    source: ingredientMergeSuggestionRef,
    target: ingredientMergeSuggestionRef.nullable(),
    confidence,
    reasoning: z.string(),
  }),
);

export const enrichmentProposalPrecomputeInput = z.object({
  items: z
    .array(
      z.object({
        // The public id, like every other browser boundary — the workflow resolves
        // it to a uuid. This took `ingredientId` (a uuid brand) while the only
        // caller reads `enrichmentRowOut.id`, a shortcode, so every precompute
        // request failed input validation with "Invalid UUID".
        id: ingredientShortcode,
        name: z.string().min(1),
        wantUsda: z.boolean(),
        wantMerge: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
});

const aiStreamProgressFields = {
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
};

export const aiBackfillLocationDescriptionsEventSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("progress"), ...aiStreamProgressFields }),
    z.object({
      type: z.literal("done"),
      result: z.object({
        enqueued: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      }),
    }),
  ],
);

export const aiEnrichmentProposalEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    ...aiStreamProgressFields,
    item: z
      .object({
        id: z.string(),
        usda: usdaFoodSuggestionOut,
        merge: z
          .object({
            target: z
              .object({
                id: z.string(),
                shortcode: z.string(),
                name: z.string(),
              })
              .nullable(),
            confidence,
            reasoning: z.string(),
          })
          .nullable(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("done"),
    result: z.object({ processed: z.number().int().nonnegative() }),
  }),
]);

export const aiUsageCacheStatus = z.enum(["hit", "miss", "none"]);
export type AiUsageCacheStatus = z.infer<typeof aiUsageCacheStatus>;

export { aiUsageTransport, aiUsageTransportValues, type AiUsageTransport };

const aiUsageStatus = z.enum(["succeeded", "failed"]);

/** Filters narrow the whole history before `limit` takes the newest rows. */
const aiUsageRecentFilters = z.object({
  transport: aiUsageTransport.optional(),
  status: aiUsageStatus.optional(),
  /** Exact matches. */
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  /** Case-insensitive substring of feature, model, or operation. */
  query: z.string().trim().min(1).optional(),
});
export type AiUsageRecentFilters = z.infer<typeof aiUsageRecentFilters>;

export const aiUsageRecentInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  filters: aiUsageRecentFilters.optional(),
});
export type AiUsageRecentInput = z.infer<typeof aiUsageRecentInput>;

// Grouping dimensions shared by per-row usage entries and rolled-up summaries.
const aiUsageGroupFields = {
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  operation: z.string(),
  jobKind: z.string().nullable(),
  jobId: z.string().nullable(),
  cacheStatus: aiUsageCacheStatus.nullable(),
  applicationCacheStatus: aiUsageCacheStatus.nullable(),
  transport: aiUsageTransport,
};

export const aiUsageEntrySchema = z.object({
  id: z.string(),
  ...aiUsageGroupFields,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  attempt: z.number().int().nonnegative(),
  status: aiUsageStatus,
  gatewayLogId: z.string().nullable(),
  estimatedCost: moneyNullable,
  durationMs: z.number().int(),
  entityKind: z.string().nullable(),
  entityId: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const aiUsageFilterOptionsOut = z.object({
  provider: z.array(z.string()),
  model: z.array(z.string()),
  feature: z.array(z.string()),
});

export const aiUsageRecentOut = z.array(aiUsageEntrySchema);
export type AiUsageEntry = z.infer<typeof aiUsageEntrySchema>;

/** `run.aiUsage` — one Run's AI calls, newest first, cursor-paginated. */
export const aiRunUsageInput = z.object({
  runId: runShortcode,
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export const aiRunUsageOut = z.object({
  /** Sum over every priced call in the run, not just this page. */
  pricedSubtotal: z.number().nonnegative(),
  unpricedCount: z.number().int().nonnegative(),
  records: z.array(
    aiUsageEntrySchema.pick({
      id: true,
      createdAt: true,
      feature: true,
      operation: true,
      provider: true,
      model: true,
      attempt: true,
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      durationMs: true,
      status: true,
      gatewayLogId: true,
      cacheStatus: true,
      applicationCacheStatus: true,
      transport: true,
      estimatedCost: true,
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type AiRunUsage = z.infer<typeof aiRunUsageOut>;

export const aiUsageSummaryInput = z.object({
  days: z.number().int().min(1).max(90).default(7),
});

export const aiUsageSummaryRowSchema = z.object({
  day: z.string(),
  ...aiUsageGroupFields,
  count: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  estimatedCost: moneyNullable,
  durationMs: z.number().int(),
});

export const aiUsageSummaryOut = z.array(aiUsageSummaryRowSchema);
export type AiUsageSummaryRow = z.infer<typeof aiUsageSummaryRowSchema>;

/**
 * `ai.suggestFields` — one request per record or form. Independent targets
 * resolve concurrently; only `suggested` mode chains dependencies. `targets`
 * and the keys of `basis` are bare manifest field keys of `entity` (not
 * `entity.field` composites — `entity` already scopes them); `basis` values
 * are shortcodes for reference fields and plain text otherwise, `null` when
 * unset/unknown. `provided` mode never uses another target's proposal as evidence.
 */
export const suggestionPurchaseEvidenceSchema = z.object({
  principalLineCount: z.number().int(),
  distinctPurchaseCount: z.number().int(),
  unknownCategoryLineCount: z.number().int(),
  truncated: z.boolean(),
  categories: z.array(
    z.object({
      id: productCategoryShortcode,
      name: z.string(),
      emoji: z.string().nullable(),
      principalLineCount: z.number().int(),
      distinctPurchaseCount: z.number().int(),
    }),
  ),
});
export const financeCategoryReviewSchema = z.object({
  evidence: suggestionPurchaseEvidenceSchema.optional(),
  entity: z.enum(["financialTransaction", "purchase", "expense", "vendor"]),
  entityId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  field: z
    .enum([
      "spendingCategoryId",
      "defaultSpendingCategoryId",
      "spendingProfile",
    ])
    .optional(),
});
export const financeCategoryApplyInput = financeCategoryReviewSchema
  .omit({ evidence: true })
  .extend({
    spendingCategoryId: spendingCategoryShortcode.optional(),
    defaultSpendingCategoryId: spendingCategoryShortcode.optional(),
    spendingProfile: vendorSpendingProfile.optional(),
  });
export const financeCategoryApplyOut = financeCategoryApplyInput
  .omit({ fingerprint: true })
  .extend({
    sideEffects: mutationSideEffectsSchema,
  });
export type FinanceCategoryApplyInput = z.infer<
  typeof financeCategoryApplyInput
>;

export const fieldSuggestionsInput = z.object({
  entityId: z.string().min(1).optional(),
  basisMode: z.enum(["provided", "suggested"]),
  entity: z.enum(shortcodeEntities),
  targets: z.array(z.string().min(1)).min(1),
  basis: z.record(z.string(), z.string().nullable()),
  /**
   * One id per page mount, minted client-side and reused across every
   * `suggestFields` call that page makes — groups them into one `ai_suggest`
   * run instead of a run per field. Omitted shares the actor's run for the
   * UTC hour.
   */
  runKey: z.string().uuid().optional(),
});
export type FieldSuggestionsInput = z.infer<typeof fieldSuggestionsInput>;

export const suggestionStatus = z.enum([
  "pending",
  "applied",
  "rejected",
  "superseded",
]);
export const suggestionReviewListInput = z.object({
  entity: z.enum(shortcodeEntities).optional(),
  field: z.string().optional(),
  kind: z.enum(["correction", "addition"]).optional(),
  minConfidence: z.number().min(0).max(1).default(0.5),
  runId: z.string().uuid().optional(),
  /** Bounded list-page read; both are supplied together by generic entity lists. */
  recordIds: z.array(z.string().uuid()).max(250).optional(),
  fields: z.array(z.string()).max(100).optional(),
});
export const suggestionReviewRowSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  entity: z.enum(shortcodeEntities),
  recordId: z.string().uuid(),
  field: z.string(),
  currentValue: z.json().nullable(),
  suggestedValue: z.json(),
  confidence: z.number(),
  model: z.string(),
  kind: z.enum(["correction", "addition"]),
  correctValue: z.json().nullable(),
});
export const suggestionReviewListOut = z.array(suggestionReviewRowSchema);
export type SuggestionReviewRow = z.infer<typeof suggestionReviewRowSchema>;
export const suggestionReviewActionInput = z.object({ id: z.string().uuid() });
export const suggestionReviewBatchInput = z.object({
  ids: z.array(z.string().uuid()).min(1),
});
export const suggestionReviewRejectInput = suggestionReviewActionInput.extend({
  correctValue: z.json().optional(),
});
export const suggestionReviewActionOut = z.object({
  id: z.string().uuid(),
  status: z.enum(["applied", "rejected"]),
});
export const suggestionReviewBatchOut = z.array(suggestionReviewActionOut);
export const fieldSuggestionMissInput = z.object({
  entity: z.enum(shortcodeEntities),
  entityId: z.string().min(1),
  field: z.string().min(1),
  runKey: z.string().uuid(),
  currentValue: z.json().nullable(),
  suggestedValue: z.string(),
  confidence: z.number().min(0).max(1),
});
export const fieldSuggestionMissOut = z.object({ recorded: z.literal(true) });
export const suggestionSweepStartInput = z.object({
  entity: z.enum(shortcodeEntities),
  fields: z.array(z.string().min(1)).min(1),
  filters: z.record(z.string(), z.json()).default({}),
});
export const suggestionSweepStartOut = z.object({ id: z.string().uuid() });
export const suggestionSweepControlInput = z.object({
  runId: z.string().uuid(),
});
export const suggestionSweepStatusOut = z.object({
  latestRunId: z.string().uuid().nullable(),
  entity: z.string().nullable(),
  fields: z.array(z.string()),
  taxonomyChanged: z.boolean(),
  status: z.string().nullable(),
  paused: z.boolean(),
  progress: z.json().nullable(),
});

/**
 * One target's answer: `value` is the raw field value (a shortcode for a
 * reference target, the enum member for an enum target, the chosen string
 * for a text-roster target), `label` is display text, and `detail` is
 * secondary context (e.g. a location's ancestor path) when the spec has one.
 * `null` means no suggestion could be made — see `outcomes` for why.
 */
/**
 * A runner-up from Jev's calibrated distribution over every choice, so a
 * picker can pin the top few candidates instead of only the winner. Empty on
 * the roster-overflow path (a chat-tier pick has no distribution).
 */
export const fieldSuggestionAlternativeSchema = z.object({
  value: z.string(),
  label: z.string(),
  detail: z.string().nullable().default(null),
  probability: z.number().min(0).max(1),
});
export type FieldSuggestionAlternative = z.infer<
  typeof fieldSuggestionAlternativeSchema
>;

/** One entry a `remove` suggestion proposes dropping from a text-array target. */
export const fieldSuggestionRemovalSchema = z.object({
  value: z.string(),
  probability: z.number().min(0).max(1),
  /** Why it is redundant, e.g. "restates manufacturer". */
  reason: z.string(),
});
export type FieldSuggestionRemoval = z.infer<
  typeof fieldSuggestionRemovalSchema
>;

export const fieldSuggestionSchema = z.object({
  financeReview: financeCategoryReviewSchema.optional(),
  value: z.string().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
  confidence,
  /** Calibrated Jev probability; null for non-Jev/absent suggestions. */
  probability: z.number().min(0).max(1).nullable().default(null),
  reasoning: z.string(),
  alternatives: z.array(fieldSuggestionAlternativeSchema).default([]),
  /**
   * `set` writes `value` to the target; `remove` subtracts `removals[].value`
   * from a text-array target (a `mode: "prune"` suggest field). For `remove`,
   * `value` is the sorted removed entries joined by ", " so review surfaces
   * can dedupe and diff it like any other suggestion, `label` is the human
   * proposal, and `probability` is the weakest included removal.
   */
  operation: z.enum(["set", "remove"]).default("set"),
  removals: z.array(fieldSuggestionRemovalSchema).default([]),
});
export type FieldSuggestion = z.infer<typeof fieldSuggestionSchema>;

/**
 * What happened to one requested target, whether or not `suggestions[target]`
 * carries a proposal. `skipped` means the decision tier was never asked:
 * `no_signal` (an unusable basis), `no_candidates` (an empty roster), or
 * `resolved` (inheritance already answers the field — see
 * `fieldResolutions`). `evaluated` means it answered: `pick` chose a
 * candidate (the proposal is in `suggestions`), `none` declined every
 * candidate (a fill target) or kept every entry (a prune target).
 */
export const fieldSuggestionOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skipped"),
    reason: z.enum(["no_signal", "no_candidates", "resolved"]),
  }),
  z.object({
    kind: z.literal("evaluated"),
    answer: z.enum(["pick", "none"]),
    confidence,
    /** Calibrated probability of `answer` — the winner's for a pick, `none`'s
     * for a decline. Null only on the roster-overflow chat tier. */
    probability: z.number().min(0).max(1).nullable(),
    /** Ranked runners-up; for a decline, the closest calls. */
    alternatives: z.array(fieldSuggestionAlternativeSchema).default([]),
  }),
]);
export type FieldSuggestionOutcome = z.infer<
  typeof fieldSuggestionOutcomeSchema
>;

/** Input for classifying one external identifier's `kind` from its shape and source. */
export const externalIdKindSuggestionInput = z.object({
  source: z.string().trim().min(1),
  identifier: z.string().trim().min(2),
  url: z.string().nullable().default(null),
  productName: z.string().nullable().default(null),
  manufacturer: z.string().nullable().default(null),
  /** Same page-mount id `ai.suggestFields` groups under; see there. */
  runKey: z.string().uuid().optional(),
});
/** A `FieldSuggestion` over the six non-legacy `ExternalIdKind` values, so
 * the existing hint UI (`FieldSuggestionHint`) consumes it unchanged. `null`
 * only when the identifier carries no usable signal at all. */
export const suggestExternalIdKindOut = fieldSuggestionSchema.nullable();
export type SuggestExternalIdKindOut = z.infer<typeof suggestExternalIdKindOut>;

export type ExternalIdKindSuggestionInput = z.infer<
  typeof externalIdKindSuggestionInput
>;

export const fieldSuggestionsOut = z.object({
  suggestions: z.record(z.string(), fieldSuggestionSchema.nullable()),
  /** Authoritative inheritance state for this exact draft snapshot. */
  fieldResolutions: fieldResolutionsSchema.optional(),
  /** Requested targets the server allowed Jev to evaluate. */
  eligibleTargets: z.array(z.string()).optional(),
  /** One entry per requested target; why `suggestions[target]` is or isn't a
   * proposal. */
  outcomes: z.record(z.string(), fieldSuggestionOutcomeSchema).optional(),
});
export type FieldSuggestionsOut = z.infer<typeof fieldSuggestionsOut>;

/** Swift keeps nullable object properties, but drops nullable dictionary values. */
export const fieldSuggestionsReviewOut = fieldSuggestionsOut
  .omit({ suggestions: true })
  .extend({
    suggestions: z.array(
      z.object({
        field: z.string(),
        suggestion: fieldSuggestionSchema.nullable(),
      }),
    ),
  });

/** JSON-safe provider runtime details, independent of any feature result schema. */
export type AiAnalysisRuntime = Record<
  string,
  z.infer<ReturnType<typeof z.json>>
>;

import { z } from "zod";
import { fieldResolutionsSchema } from "./field-resolution";
import { mutationSideEffectsSchema } from "./background-jobs";
import { shortcodeEntities } from "./entity-manifest";
import { moneyNullable } from "./money";
import {
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { productCategory } from "./product-fields";
import { foodSummaryWithLinkedProducts } from "./usda";

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

export const locationDescriptionSchema = z.object({
  description: z.string(),
  confidence: confidence,
});
export type LocationDescription = z.infer<typeof locationDescriptionSchema>;

export const aiAnalysisEntityType = z.enum([
  "image",
  "location",
  "product",
  "recipe",
  "global",
]);
export type AiAnalysisEntityType = z.infer<typeof aiAnalysisEntityType>;

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
  food: foodSummaryWithLinkedProducts.nullable(),
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

export const aiUsageRecentInput = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

// Grouping dimensions shared by per-row usage entries and rolled-up summaries.
const aiUsageGroupFields = {
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  operation: z.string(),
  jobKind: z.string().nullable(),
  jobId: z.string().nullable(),
  cacheStatus: aiUsageCacheStatus.nullable(),
};

export const aiUsageEntrySchema = z.object({
  id: z.string(),
  ...aiUsageGroupFields,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cacheReadTokens: z.number().int().nullable(),
  cacheWriteTokens: z.number().int().nullable(),
  attempt: z.number().int().positive(),
  status: z.enum(["succeeded", "failed"]),
  gatewayLogId: z.string().nullable(),
  estimatedCost: moneyNullable,
  durationMs: z.number().int(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const aiUsageRecentOut = z.array(aiUsageEntrySchema);
export type AiUsageEntry = z.infer<typeof aiUsageEntrySchema>;

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
export const fieldSuggestionsInput = z.object({
  basisMode: z.enum(["provided", "suggested"]),
  entity: z.enum(shortcodeEntities),
  targets: z.array(z.string().min(1)).min(1),
  basis: z.record(z.string(), z.string().nullable()),
});
export type FieldSuggestionsInput = z.infer<typeof fieldSuggestionsInput>;

/**
 * One target's answer: `value` is the raw field value (a shortcode for a
 * reference target, the enum member for an enum target, the chosen string
 * for a text-roster target), `label` is display text, and `detail` is
 * secondary context (e.g. a location's ancestor path) when the spec has one.
 * `null` means no suggestion could be made — an unusable basis or an empty
 * roster — not an error.
 */
export const fieldSuggestionSchema = z.object({
  value: z.string().nullable(),
  label: z.string().nullable(),
  detail: z.string().nullable(),
  confidence,
  /** Calibrated Jev probability; null for non-Jev/absent suggestions. */
  probability: z.number().min(0).max(1).nullable().default(null),
  reasoning: z.string(),
});
export type FieldSuggestion = z.infer<typeof fieldSuggestionSchema>;

export const fieldSuggestionsOut = z.object({
  suggestions: z.record(z.string(), fieldSuggestionSchema.nullable()),
  /** Authoritative inheritance state for this exact draft snapshot. */
  fieldResolutions: fieldResolutionsSchema.optional(),
  /** Requested targets the server allowed Jev to evaluate. */
  eligibleTargets: z.array(z.string()).optional(),
});
export type FieldSuggestionsOut = z.infer<typeof fieldSuggestionsOut>;

/** JSON-safe provider runtime details, independent of any feature result schema. */
export type AiAnalysisRuntime = Record<
  string,
  z.infer<ReturnType<typeof z.json>>
>;

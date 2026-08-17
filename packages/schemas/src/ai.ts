import { z } from "zod";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  ingredientShortcode,
  inventoryShortcode,
  locationShortcode,
  productShortcode,
} from "./identifiers";
import { locationType } from "./location";
import { productCategory } from "./product";
import { foodSummaryWithLinkedProducts } from "./usda";

// Confidence level values - single source of truth
export const confidenceValues = ["high", "medium", "low"] as const;

// Confidence level schema
export const confidence = z.enum(confidenceValues);

export type Confidence = z.infer<typeof confidence>;

// Category suggestion schema
export const categorySuggestionSchema = z.object({
  category: productCategory,
  confidence: confidence,
  reasoning: z.string(),
});

export type CategorySuggestion = z.infer<typeof categorySuggestionSchema>;

export const categorySuggestionInput = z.object({
  productName: z.string().min(1),
  manufacturer: z.string().min(1),
});

// Location type suggestion schema
export const locationTypeSuggestionSchema = z.object({
  type: locationType,
  confidence: confidence,
  reasoning: z.string(),
});

export type LocationTypeSuggestion = z.infer<
  typeof locationTypeSuggestionSchema
>;

export const locationTypeSuggestionInput = z.object({
  locationName: z.string().min(1),
});

export const aiLocationIdInput = z.object({
  locationId: locationShortcode,
});

export const locationSuggestionInput = z.object({
  productId: productShortcode,
});

// Model-owned shape: where should this product be put away. The id is a plain
// string on purpose — it is whatever the model copied out of the candidate
// roster, and only becomes a `locationShortcode` after the service has matched
// it back against a real live location.
export const locationSuggestionAiResultSchema = z.object({
  locationId: z.string(),
  confidence: confidence,
  reasoning: z.string(),
});
export type LocationSuggestionAiResult = z.infer<
  typeof locationSuggestionAiResultSchema
>;

// What the client gets: a resolved location, name included, so the combobox can
// render the pick without a second round trip.
export const locationSuggestionSchema = z.object({
  location: z.object({
    id: locationShortcode,
    name: z.string(),
  }),
  confidence: confidence,
  reasoning: z.string(),
});
export type LocationSuggestion = z.infer<typeof locationSuggestionSchema>;

// Location description from photo analysis
export const locationDescriptionSchema = z.object({
  description: z.string(),
  confidence: confidence,
});
export type LocationDescription = z.infer<typeof locationDescriptionSchema>;

export const aiAnalysisEntityType = z.enum([
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
  category: productCategory.nullable(),
  confidence: confidence,
  evidence: z.string(),
  isMisc: z.boolean(),
};

// Raw detected inventory item from photo analysis.
// This is the model-owned shape before app-side product matching.
export const detectedInventoryItemSchema = z.object(
  detectedInventoryItemFields,
);
export type DetectedInventoryItem = z.infer<typeof detectedInventoryItemSchema>;

// Each detected item triggers product matching work after the model response.
// Keep the structured-output fan-out bounded for a single photo analysis.
export const MAX_DETECTED_INVENTORY_ITEMS = 20;

export const detectedProductMatchSchema = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
});
export type DetectedProductMatch = z.infer<typeof detectedProductMatchSchema>;

// Reviewable inventory suggestion returned to the UI after app-side matching.
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

// Product identification from photo analysis
export const productIdentificationSchema = z.object({
  name: z.string(),
  manufacturer: z.string(),
  category: productCategory.nullable(),
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

// `id` alongside `name` lets a per-item infra failure (as opposed to a
// genuine no-match) dispatch a background retry keyed on the real ingredient
// — see `suggestUsdaFoodBatch`'s `Promise.allSettled` catch.
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
        // The public id, like every other tRPC boundary — the router resolves
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

export const parseSearchInput = z.object({
  query: z.string().min(1),
});

// Parsed natural language search query
export const parsedSearchSchema = z.object({
  productName: z.string().nullable(),
  locationName: z.string().nullable(),
  interpretation: z.string(),
});
export type ParsedSearch = z.infer<typeof parsedSearchSchema>;

// Category audit schema - AI suggests missing categories
export const categoryAuditSchema = z.object({
  suggestions: z.array(
    z.object({
      categoryName: z.string(),
      description: z.string(),
      productNames: z.array(z.string()),
      reasoning: z.string(),
    }),
  ),
  summary: z.string(),
});

export type CategoryAudit = z.infer<typeof categoryAuditSchema>;

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
  cacheStatus: aiUsageCacheStatus.nullable(),
};

export const aiUsageEntrySchema = z.object({
  id: z.string(),
  ...aiUsageGroupFields,
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  estimatedCost: z.number().nullable(),
  durationMs: z.number().int(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  batchId: z.string().nullable(),
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
  estimatedCost: z.number().nullable(),
  durationMs: z.number().int(),
});

export const aiUsageSummaryOut = z.array(aiUsageSummaryRowSchema);
export type AiUsageSummaryRow = z.infer<typeof aiUsageSummaryRowSchema>;

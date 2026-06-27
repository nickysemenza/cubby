import { z } from "zod";
import { ingredientId, locationId } from "./identifiers";
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
  locationId,
});

// Location description from photo analysis
export const locationDescriptionSchema = z.object({
  description: z.string(),
  confidence: confidence,
});
export type LocationDescription = z.infer<typeof locationDescriptionSchema>;

// Detected inventory item from photo analysis
export const detectedItemSchema = z.object({
  name: z.string(),
  manufacturer: z.string(),
  estimatedQuantity: z.number().positive(),
  unit: z.string(),
  confidence: confidence,
});
export type DetectedItem = z.infer<typeof detectedItemSchema>;

export const detectedInventorySchema = z.object({
  items: z.array(detectedItemSchema),
  summary: z.string(),
});
export type DetectedInventory = z.infer<typeof detectedInventorySchema>;

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

export const usdaFoodSuggestionOut = z.object({
  food: foodSummaryWithLinkedProducts.nullable(),
  confidence,
  reasoning: z.string(),
});

export const usdaFoodSuggestionBatchInput = z.object({
  ingredientNames: z.array(z.string().min(1)).min(1).max(20),
});

export const usdaFoodSuggestionBatchOut = z.array(
  usdaFoodSuggestionOut.extend({
    name: z.string(),
  }),
);

export const ingredientMergeSuggestionItem = z.object({
  id: ingredientId,
  name: z.string().min(1),
});

export const ingredientMergeSuggestionBatchInput = z.object({
  ingredients: z.array(ingredientMergeSuggestionItem).min(1).max(20),
});

const ingredientMergeSuggestionRef = z.object({
  id: ingredientId,
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
        id: ingredientId,
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

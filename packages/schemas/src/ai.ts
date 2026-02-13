import { z } from "zod";
import { locationType } from "./location";
import { productCategory } from "./product";

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

// Location type suggestion schema
export const locationTypeSuggestionSchema = z.object({
  type: locationType,
  confidence: confidence,
  reasoning: z.string(),
});

export type LocationTypeSuggestion = z.infer<
  typeof locationTypeSuggestionSchema
>;

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

// Parsed natural language search query
export const parsedSearchSchema = z.object({
  productName: z.string().nullable(),
  locationName: z.string().nullable(),
  interpretation: z.string(),
});
export type ParsedSearch = z.infer<typeof parsedSearchSchema>;

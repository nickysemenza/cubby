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

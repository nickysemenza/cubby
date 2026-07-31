import { z } from "zod";
import { ingredientShortcode, recipeShortcode } from "./identifiers";

// Schema for co-occurrence output - used by both router and repo
const ingredientNodeSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  recipeCount: z.number(),
});

const ingredientEdgeSchema = z.object({
  source: ingredientShortcode,
  target: ingredientShortcode,
  weight: z.number(),
  recipes: z.array(z.object({ id: recipeShortcode, name: z.string() })),
});

export const ingredientCooccurrenceSchema = z.object({
  nodes: z.array(ingredientNodeSchema),
  edges: z.array(ingredientEdgeSchema),
});

// Derived types
export type IngredientNode = z.infer<typeof ingredientNodeSchema>;
export type IngredientEdge = z.infer<typeof ingredientEdgeSchema>;
export type IngredientCooccurrence = z.infer<
  typeof ingredientCooccurrenceSchema
>;

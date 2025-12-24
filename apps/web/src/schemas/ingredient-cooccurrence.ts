import { z } from "zod";

// Schema for co-occurrence output - used by both router and repo
export const ingredientNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  recipeCount: z.number(),
});

export const ingredientEdgeSchema = z.object({
  source: z.string(),
  target: z.string(),
  weight: z.number(),
  recipes: z.array(z.object({ id: z.string(), name: z.string() })),
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

import { z } from "zod";
import {
  ingredientId,
  ingredientShortcode,
  recipeId,
  recipeShortcode,
} from "./identifiers";

// Schema for co-occurrence output - used by both router and repo
const ingredientNodeSchema = z.object({
  id: ingredientId,
  shortcode: ingredientShortcode,
  name: z.string(),
  recipeCount: z.number(),
});

const ingredientEdgeSchema = z.object({
  source: ingredientId,
  target: ingredientId,
  weight: z.number(),
  recipes: z.array(
    z.object({ id: recipeId, shortcode: recipeShortcode, name: z.string() }),
  ),
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

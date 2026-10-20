import { z } from "zod";
import { ingredientShortcode } from "./identifiers";
import { recipeRefOut } from "./recipe-shared";

const ingredientNodeSchema = z.object({
  id: ingredientShortcode,
  name: z.string(),
  recipeCount: z.number(),
});

const ingredientEdgeSchema = z.object({
  source: ingredientShortcode,
  target: ingredientShortcode,
  weight: z.number(),
  recipes: z.array(recipeRefOut),
});

export const ingredientCooccurrenceSchema = z.object({
  nodes: z.array(ingredientNodeSchema),
  edges: z.array(ingredientEdgeSchema),
});

export type IngredientNode = z.infer<typeof ingredientNodeSchema>;
export type IngredientEdge = z.infer<typeof ingredientEdgeSchema>;
export type IngredientCooccurrence = z.infer<
  typeof ingredientCooccurrenceSchema
>;

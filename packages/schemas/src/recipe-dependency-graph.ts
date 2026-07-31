import { z } from "zod";
import { cookbookId, recipeId, recipeShortcode } from "./identifiers";

// Node + edge shapes for the recipe-as-ingredient dependency graph.
// An edge points parent → sub ("uses / depends on"): the source recipe contains
// an ingredient row whose `recipeId` resolves to the target (sub-)recipe.
const recipeDepNodeSchema = z.object({
  id: recipeId,
  shortcode: recipeShortcode,
  name: z.string(),
  cookbookId: cookbookId.nullable(),
  cookbookName: z.string().nullable(),
  // True when the recipe is referenced as a sub-recipe but falls outside the
  // active cookbook filter — included so its inbound edge isn't dangling.
  external: z.boolean(),
});

const recipeDepEdgeSchema = z.object({
  source: recipeId,
  target: recipeId,
});

export const recipeDependencyGraphSchema = z.object({
  nodes: z.array(recipeDepNodeSchema),
  edges: z.array(recipeDepEdgeSchema),
});

export type RecipeDepNode = z.infer<typeof recipeDepNodeSchema>;
export type RecipeDepEdge = z.infer<typeof recipeDepEdgeSchema>;
export type RecipeDependencyGraph = z.infer<typeof recipeDependencyGraphSchema>;

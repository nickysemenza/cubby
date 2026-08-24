import { z } from "zod";
import { cookbookShortcode, recipeShortcode } from "./identifiers";

const recipeDepNodeSchema = z.object({
  id: recipeShortcode,
  name: z.string(),
  cookbookId: cookbookShortcode.nullable(),
  cookbookName: z.string().nullable(),
  external: z.boolean(),
});

const recipeDepEdgeSchema = z.object({
  source: recipeShortcode,
  target: recipeShortcode,
});

export const recipeDependencyGraphSchema = z.object({
  nodes: z.array(recipeDepNodeSchema),
  edges: z.array(recipeDepEdgeSchema),
});

export type RecipeDepNode = z.infer<typeof recipeDepNodeSchema>;
export type RecipeDepEdge = z.infer<typeof recipeDepEdgeSchema>;
export type RecipeDependencyGraph = z.infer<typeof recipeDependencyGraphSchema>;

import { z } from "zod";

// Mirrors the `CookbookRecipe` JSON emitted by `food-cli scrape-epub --json`
// (the `recipe-epub` crate in the ingredient-parser repo). Ingredient and
// instruction lines are raw strings — the server parses them on import, exactly
// like the URL scraper's CompactRecipe. Lenient by design: the LLM extractor
// omits empty metadata, so most fields are optional.

const cookbookRecipeTimes = z.object({
  active: z.string().optional(),
  total: z.string().optional(),
  prep: z.string().optional(),
  cook: z.string().optional(),
});

const cookbookRecipeMeta = z.object({
  title: z.string(),
  description: z.string().optional(),
  // Freeform yield line, e.g. "Makes 1 loaf" — NOT structured {value, unit}.
  recipe_yield: z.string().optional(),
  times: cookbookRecipeTimes.optional(),
  equipment: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
  category: z.string().optional(),
  page: z.string().optional(),
});

const cookbookRecipeSection = z.object({
  name: z.string().optional(),
  ingredients: z.array(z.string()),
  instructions: z.array(z.string()).default([]),
});

// A detected reference from one recipe to another in the same cookbook
// (recipe-epub's `resolve_references()`): the verbatim ingredient `line` points
// at another recipe's `title`. `linked` = confirmed by an EPUB anchor href;
// `title_match` = the title appears in the line.
export const recipeRefSchema = z.object({
  title: z.string(),
  line: z.string(),
  confidence: z.enum(["linked", "title_match"]),
});
export type RecipeRef = z.infer<typeof recipeRefSchema>;

export const cookbookRecipeSchema = z.object({
  meta: cookbookRecipeMeta,
  sections: z.array(cookbookRecipeSection),
  // The book label (food-cli passes the .epub path); provenance only.
  source: z.string().optional(),
  // Synthetic `source#doc_path`, not a real URL; provenance only.
  url: z.string().optional(),
  // Cross-recipe references (other recipes in the same book this one uses as
  // ingredients). Defaults to empty for older JSON without the field.
  references: z.array(recipeRefSchema).default([]),
});
export type CookbookRecipe = z.infer<typeof cookbookRecipeSchema>;

// What an uploaded `--json` file contains.
export const cookbookRecipesSchema = z.array(cookbookRecipeSchema);

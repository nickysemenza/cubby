import { z } from "zod";
import { type CompactRecipe, sanitizeSectionName } from "./codec";

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

export const cookbookRecipeSchema = z.object({
  meta: cookbookRecipeMeta,
  sections: z.array(cookbookRecipeSection),
  // The book label (food-cli passes the .epub path); provenance only.
  source: z.string().optional(),
  // Synthetic `source#doc_path`, not a real URL; provenance only.
  url: z.string().optional(),
});
export type CookbookRecipe = z.infer<typeof cookbookRecipeSchema>;

// What an uploaded `--json` file contains.
export const cookbookRecipesSchema = z.array(cookbookRecipeSchema);

/** Structured yield parsed from the cookbook's freeform yield string. */
export interface ParsedYield {
  recipe_yield?: { value: number; unit: string };
  servings?: number;
}

/**
 * Map an extracted `CookbookRecipe` onto cubby's `CompactRecipe` so it can flow
 * through the existing parse + find-or-create + upsert pipeline.
 *
 * - `meta` (url) is omitted: the cookbook's `url` is a synthetic `source#doc_path`
 *   that fails `compactMeta`'s `z.url()`. Book provenance is carried separately
 *   (SourceType="Book", SourceData=<book name>) by the import endpoint.
 * - `image` is omitted (EPUB extraction has none).
 * - Yield is freeform text in the cookbook, so the caller parses it (via the
 *   WASM `parse_yield`, kept out of this pure schema package) and passes the
 *   structured result in.
 */
export const cookbookRecipeToCompact = (
  cr: CookbookRecipe,
  parsedYield?: ParsedYield,
): CompactRecipe => {
  return {
    name: cr.meta.title,
    sections: cr.sections.map((section) => ({
      name: sanitizeSectionName(section.name),
      ingredients: section.ingredients,
      instructions: section.instructions,
    })),
    recipe_yield: parsedYield?.recipe_yield,
    servings: parsedYield?.servings,
  };
};

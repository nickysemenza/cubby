import { z } from "zod";

const compactMeta = z.object({ url: z.url().optional() }).optional();

// Schema for parsed recipe yield from scraper (matches WRecipeYield from WASM)
const compactRecipeYield = z.object({
  value: z.number(),
  unit: z.string(),
});

export const compactRecipeSchema = z.object({
  name: z.string(),
  meta: compactMeta,
  sections: z.array(
    z.object({
      ingredients: z.array(z.string()),
      instructions: z.array(z.string()),
    }),
  ),
  // Optional yield parsed from scraper (e.g., { value: 12, unit: "pancakes" })
  recipe_yield: compactRecipeYield.optional(),
  // Optional servings as integer (extracted from yield if unit is "serving(s)")
  servings: z.number().optional(),
});
export type CompactRecipe = z.infer<typeof compactRecipeSchema>;
export const amount = z.object({
  value: z.number(),
  unit: z.string().min(1),
});
export type Amount = z.infer<typeof amount>;
const parsedIngredient = z.object({
  name: z.string(),
  amounts: z.array(amount),
  modifier: z.string().optional(),
});
// Used only for type inference
const parsedCompactRecipeSchema = z.object({
  name: z.string(),
  meta: compactMeta,
  sections: z.array(
    z.object({
      ingredients: z.array(parsedIngredient),
      instructions: z.array(z.string()),
    }),
  ),
});
export type ParsedCompactRecipe = z.infer<typeof parsedCompactRecipeSchema>;

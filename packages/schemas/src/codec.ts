import { z } from "zod";

export const amount = z.object({
  value: z.number(),
  unit: z.string().min(1),
});
export type Amount = z.infer<typeof amount>;

// Optional provenance shared by the raw and parsed compact recipe shapes.
const compactMeta = z.object({ url: z.url().optional() }).optional();

// Schema for parsed recipe yield from scraper (matches WRecipeYield from WASM)
const compactRecipeYield = z.object({
  value: z.number(),
  unit: z.string(),
});

// A single ingredient after WASM parsing (name + structured amounts).
const parsedIngredient = z.object({
  name: z.string(),
  amounts: z.array(amount),
  modifier: z.string().optional(),
});

// A compact recipe section. The raw and parsed pipeline stages differ only in how an
// ingredient is represented: an unparsed string before WASM, a parsedIngredient after.
const compactSection = <T extends z.ZodTypeAny>(ingredients: T) =>
  z.object({
    name: z.string().nullable().optional(),
    ingredients: z.array(ingredients),
    instructions: z.array(z.string()),
  });

// Raw scraped recipe: ingredients are unparsed strings.
export const compactRecipeSchema = z.object({
  name: z.string(),
  meta: compactMeta,
  sections: z.array(compactSection(z.string())),
  // Optional yield parsed from scraper (e.g., { value: 12, unit: "pancakes" })
  recipe_yield: compactRecipeYield.optional(),
  // Optional servings as integer (extracted from yield if unit is "serving(s)")
  servings: z.number().optional(),
});
export type CompactRecipe = z.infer<typeof compactRecipeSchema>;

// Parsed compact recipe: ingredients are structured. Used only for type inference.
const parsedCompactRecipeSchema = z.object({
  name: z.string(),
  meta: compactMeta,
  sections: z.array(compactSection(parsedIngredient)),
});
export type ParsedCompactRecipe = z.infer<typeof parsedCompactRecipeSchema>;

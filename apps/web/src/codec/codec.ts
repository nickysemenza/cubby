import { z } from "zod";

const compactMeta = z.object({ url: z.url().optional() }).optional();
export const compactRecipeSchema = z.object({
  name: z.string(),
  meta: compactMeta,
  sections: z.array(
    z.object({
      ingredients: z.array(z.string()),
      instructions: z.array(z.string()),
    }),
  ),
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

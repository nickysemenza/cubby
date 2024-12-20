import { z } from "zod";

export const compactRecipeSchema = z.object({
  name: z.string(),
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
  unit: z.string(),
});
export const parsedIngredient = z.object({
  name: z.string(),
  amounts: z.array(amount),
  modifier: z.string().optional(),
});
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const parsedCompactRecipeSchema = z.object({
  name: z.string(),
  sections: z.array(
    z.object({
      ingredients: z.array(parsedIngredient),
      instructions: z.array(z.string()),
    }),
  ),
});
export type ParsedCompactRecipe = z.infer<typeof parsedCompactRecipeSchema>;

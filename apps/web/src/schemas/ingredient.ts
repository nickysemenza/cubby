import { z } from "zod";
import { dbTimestampsOut } from "~/schemas/common";
import { ingredientId } from "./identifiers";

export const ingredientBase = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
});
export const ingredientOut = z
  .object({
    id: ingredientId,
  })
  .extend(ingredientBase.shape)
  .extend(dbTimestampsOut.shape);

/**
 * Input schema for updating ingredients
 * @lintignore knip false positive - used in ingredient-form.tsx
 */
export const ingredientUpdateInput = z.object({
  id: ingredientId,
  data: ingredientBase.partial(),
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

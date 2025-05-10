import { z } from "zod";
import { dbTimestampsOut } from "~/schemas/util";

export const ingredientBase = z.object({
  name: z.string(),
  aliases: z.array(z.string()),
});
export const ingredientOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(ingredientBase)
  .merge(dbTimestampsOut);

// Input schema for updating ingredients
export const ingredientUpdateInput = z.object({
  id: z.string().uuid(),
  data: ingredientBase.partial(),
});

export type IngredientUpdateInput = z.infer<typeof ingredientUpdateInput>;

import { z } from "zod";

export type ItemOut = z.infer<typeof itemOut>;
const itemOut = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.nativeEnum(ItemType),
    aliases: z.array(z.string()),
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productTopLevel),
  })
  .merge(dbTimestamps);

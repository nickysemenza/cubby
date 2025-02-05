import { ItemType } from "@prisma/client";
import { z } from "zod";
import { recipeTopLevel } from "~/schemas/recipes";
import { dbTimestamps } from "~/schemas/util";
import { productTopLevel } from "./product";

export type ItemOut = z.infer<typeof itemOut>;

export const itemOut = z
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

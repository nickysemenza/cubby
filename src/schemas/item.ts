import { ItemType } from "@prisma/client";
import { z } from "zod";
import { recipeTopLevel } from "~/schemas/recipes";
import { dbTimestampsOut } from "~/schemas/util";

export const productBase = z.object({
  name: z.string(),
  upc: z.string().length(12),
  manufacturer: z.string(),
  model: z.string().nullable(),
});

export const productTopLevelOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(productBase)
  .merge(dbTimestampsOut);

export type ItemOut = z.infer<typeof itemOut>;
export const itemBase = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.nativeEnum(ItemType),
    aliases: z.array(z.string()),
  })
  .merge(dbTimestampsOut);

export const itemOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productTopLevelOut),
  })
  .merge(itemBase);

export const productWithItemOut = productTopLevelOut.merge(
  z.object({
    item: itemBase.nullable(),
  }),
);

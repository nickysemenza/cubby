import { ItemType } from "@prisma/client";
import { z } from "zod";
import { recipeTopLevel } from "~/schemas/recipes";
import { dbTimestampsOut } from "~/schemas/util";
import { amount } from "~/codec/codec";

export const productBase = z.object({
  name: z.string(),
  upc: z.string().length(12).nullable(),
  manufacturer: z.string(),
  model: z
    .string()
    .nullish()
    // yaml parsing loads these as undefined, but need them to be null to play nice with db + json
    .transform((x) => x ?? null),
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

export const unitMappingBase = z.object({
  a: amount.describe("first of pair"),
  b: amount.describe("second of pair"),
  source: z.string().nullable(),
});

const unitMappingOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(unitMappingBase)
  .merge(dbTimestampsOut);

export const productWithItemOut = productTopLevelOut.merge(
  z.object({
    item: itemBase.nullable(),
    unitMappings: z.array(unitMappingOut),
  }),
);

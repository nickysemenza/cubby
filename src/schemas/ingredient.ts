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

export type IngredientOut = z.infer<typeof ingredientOut>;
export const ingredientBase = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    aliases: z.array(z.string()),
  })
  .merge(dbTimestampsOut);

export const ingredientOut = z
  .object({
    recipe: recipeTopLevel.nullable(),
    appearsInRecipes: z.array(recipeTopLevel),
    product: z.array(productTopLevelOut),
  })
  .merge(ingredientBase);

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

export const productWithIngredientOut = productTopLevelOut.merge(
  z.object({
    ingredient: ingredientBase.nullable(),
    unitMappings: z.array(unitMappingOut),
  }),
);

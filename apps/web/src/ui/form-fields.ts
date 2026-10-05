import {
  type IngredientShortcode,
  ingredientShortcode,
  locationShortcode,
  type ProductShortcode,
  productShortcode,
  type RecipeShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

import { ComboboxItem } from "~/ui/combobox/combobox-types";

export const requiredProductField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a product" },
);

/** An id-valued location picker (`EntityValueField`) that must be filled;
 * the picker writes "" when cleared. */
export const requiredLocationCode = z
  .string()
  .min(1, "Please select a location")
  .pipe(locationShortcode);

export function getOptionalProductShortcode(
  item: ComboboxItem | null | undefined,
): ProductShortcode | undefined {
  if (!item?.id) return undefined;
  return productShortcode.parse(item.id);
}

export function getOptionalIngredientId(
  item: ComboboxItem | null | undefined,
): IngredientShortcode | undefined {
  if (!item?.id) return undefined;
  return ingredientShortcode.parse(item.id);
}

export function getOptionalRecipeId(
  item: ComboboxItem | null | undefined,
): RecipeShortcode | undefined {
  return item?.id ? recipeShortcode.parse(item.id) : undefined;
}

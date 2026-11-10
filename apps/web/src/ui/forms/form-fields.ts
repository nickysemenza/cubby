import {
  type IngredientShortcode,
  ingredientShortcode,
  locationShortcode,
  type RecipeShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

import { ComboboxItem } from "~/ui/combobox/combobox-types";

/** An id-valued location picker (`PickerField` `store="id"`) that must be filled;
 * the picker writes "" when cleared. */
export const requiredLocationCode = z
  .string()
  .min(1, "Please select a location")
  .pipe(locationShortcode);

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

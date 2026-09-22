import { positiveAmount } from "@cubby/schemas/codec";
import {
  type IngredientShortcode,
  ingredientShortcode,
  type LocationShortcode,
  locationShortcode,
  type ProductShortcode,
  productShortcode,
  type RecipeShortcode,
  recipeShortcode,
} from "@cubby/schemas/identifiers";
import { z } from "zod";

import { ComboboxItem } from "~/app/_components/combobox/combobox-types";

export const requiredProductField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a product" },
);

export const requiredLocationField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a location" },
);

export const optionalLocationField = ComboboxItem.nullable();

export function getProductShortcode(
  item: z.input<typeof requiredProductField>,
): ProductShortcode {
  return productShortcode.parse(item!.id);
}

export function getLocationId(
  item: z.input<typeof requiredLocationField>,
): LocationShortcode {
  return locationShortcode.parse(item!.id);
}

export function getOptionalProductShortcode(
  item: ComboboxItem | null | undefined,
): ProductShortcode | undefined {
  if (!item?.id) return undefined;
  return productShortcode.parse(item.id);
}

export function getOptionalLocationId(
  item: ComboboxItem | null | undefined,
): LocationShortcode | undefined {
  if (!item?.id) return undefined;
  return locationShortcode.parse(item.id);
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

/**
 * Carries an optional id, for bulk-edit forms that mix existing (with id) and
 * new (without) rows.
 */
export const inventoryItemWithIdFields = z.object({
  product: requiredProductField,
  amount: positiveAmount,
  id: z.string().optional(),
});

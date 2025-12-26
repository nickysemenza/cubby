/**
 * Shared form field schemas for inventory-related forms.
 *
 * These schemas are used across multiple forms to ensure consistent validation
 * and reduce duplication. They handle combobox selection validation and amount fields.
 */
import { z } from "zod";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { amount } from "~/codec/codec";
import {
  type ProductId,
  type LocationId,
  type IngredientId,
  type RecipeId,
} from "./identifiers";

/**
 * Required combobox field for product selection.
 * Use with ComboboxFieldWithSearch searchType="product"
 */
export const requiredProductField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a product" },
);

/**
 * Required combobox field for location selection.
 * Use with ComboboxFieldWithSearch searchType="location"
 */
export const requiredLocationField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a location" },
);

// -----------------------------------------------------------------------------
// ID Extraction Helpers
// -----------------------------------------------------------------------------
// These functions extract branded IDs from combobox items, centralizing the
// type cast in one place. Use these instead of `item.id as ProductId` etc.

/**
 * Extracts the ProductId from a required product combobox field.
 * Use after form validation when product is guaranteed to be non-null.
 */
export function getProductId(
  item: z.infer<typeof requiredProductField>,
): ProductId {
  return item!.id as ProductId;
}

/**
 * Extracts the LocationId from a required location combobox field.
 * Use after form validation when location is guaranteed to be non-null.
 */
export function getLocationId(
  item: z.infer<typeof requiredLocationField>,
): LocationId {
  return item!.id as LocationId;
}

/**
 * Extracts an optional ProductId from a nullable product combobox field.
 * Returns undefined if the combobox is empty.
 */
export function getOptionalProductId(
  item: ComboboxItem | null | undefined,
): ProductId | undefined {
  return item?.id as ProductId | undefined;
}

/**
 * Extracts an optional LocationId from a nullable location combobox field.
 * Returns undefined if the combobox is empty.
 */
export function getOptionalLocationId(
  item: ComboboxItem | null | undefined,
): LocationId | undefined {
  return item?.id as LocationId | undefined;
}

/**
 * Extracts an optional IngredientId from a nullable ingredient combobox field.
 * Returns undefined if the combobox is empty.
 */
export function getOptionalIngredientId(
  item: ComboboxItem | null | undefined,
): IngredientId | undefined {
  return item?.id as IngredientId | undefined;
}

/**
 * Extracts an optional RecipeId from a nullable recipe combobox field.
 * Returns undefined if the combobox is empty.
 */
export function getOptionalRecipeId(
  item: ComboboxItem | null | undefined,
): RecipeId | undefined {
  return item?.id as RecipeId | undefined;
}

/**
 * Amount field schema (value + unit).
 * Re-exported from codec for convenience.
 */
export const amountField = amount;

/**
 * Schema for a single inventory item with product, location, and amount.
 * Used in forms where each item has its own location (e.g., quick-capture-form).
 */
export const inventoryItemWithLocationFields = z.object({
  product: requiredProductField,
  location: requiredLocationField,
  amount: amountField,
});

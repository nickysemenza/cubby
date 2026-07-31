/**
 * Shared form field schemas for inventory-related forms.
 *
 * These schemas are used across multiple forms to ensure consistent validation
 * and reduce duplication. They handle combobox selection validation and amount fields.
 */

import { positiveAmount } from "@cubby/schemas/codec";
import type {
  IngredientId,
  LocationId,
  ProductShortcode,
  RecipeId,
} from "@cubby/schemas/identifiers";
import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { z } from "zod";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";

/**
 * Required combobox field for product selection.
 * Use with ComboboxFieldWithSearch searchType="product"
 *
 * Note: The type remains `ComboboxItem | null` for form compatibility.
 * Use `getProductShortcode(values.product)` after validation to extract the ID.
 */
export const requiredProductField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a product" },
);

/**
 * Required combobox field for location selection.
 * Use with ComboboxFieldWithSearch searchType="location"
 *
 * Note: The type remains `ComboboxItem | null` for form compatibility.
 * Use `getLocationId(values.location)` after validation to extract the ID.
 */
export const requiredLocationField = ComboboxItem.nullable().refine(
  (item) => item !== null,
  { message: "Please select a location" },
);

/**
 * Optional combobox fields for location / ingredient selection.
 *
 * Use these instead of inlining `ComboboxItem.nullable()` in form schemas.
 * Pair with the matching `getOptional*Id` extractor below to read the id.
 */
export const optionalLocationField = ComboboxItem.nullable();
export const optionalIngredientField = ComboboxItem.nullable();

// -----------------------------------------------------------------------------
// ID Extraction Helpers
// -----------------------------------------------------------------------------
// These functions extract branded IDs from combobox items at the form boundary.

/** Extracts the public ProductShortcode used by product FK write inputs. */
export function getProductShortcode(
  item: z.input<typeof requiredProductField>,
): ProductShortcode {
  return unsafeProductShortcode(item!.id);
}

/**
 * Extracts the LocationId from a required location combobox field.
 * Use after form validation when location is guaranteed to be non-null.
 */
export function getLocationId(
  item: z.input<typeof requiredLocationField>,
): LocationId {
  return item!.id as LocationId;
}

/** Extracts an optional public ProductShortcode from a product combobox. */
export function getOptionalProductShortcode(
  item: ComboboxItem | null | undefined,
): ProductShortcode | undefined {
  if (!item?.id) return undefined;
  return unsafeProductShortcode(item.id);
}

/**
 * Extracts an optional LocationId from a nullable location combobox field.
 * Returns undefined if the combobox is empty or has an empty id.
 */
export function getOptionalLocationId(
  item: ComboboxItem | null | undefined,
): LocationId | undefined {
  // Handle null/undefined item, or item with empty id
  if (!item?.id) return undefined;
  return item.id as LocationId;
}

/**
 * Extracts an optional IngredientId from a nullable ingredient combobox field.
 * Returns undefined if the combobox is empty or has an empty id.
 */
export function getOptionalIngredientId(
  item: ComboboxItem | null | undefined,
): IngredientId | undefined {
  if (!item?.id) return undefined;
  return item.id as IngredientId;
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
 * Schema for a single inventory item with product, location, and amount.
 * Used in forms where each item has its own location.
 */
export const inventoryItemWithLocationFields = z.object({
  product: requiredProductField,
  location: requiredLocationField,
  amount: positiveAmount,
});

/**
 * Variant of {@link inventoryItemWithLocationFields} carrying an optional id,
 * for bulk-edit forms that mix existing (with id) and new (without) rows.
 */
export const inventoryItemWithIdFields = z.object({
  product: requiredProductField,
  amount: positiveAmount,
  id: z.string().optional(),
});

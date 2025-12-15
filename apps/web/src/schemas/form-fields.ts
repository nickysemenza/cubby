/**
 * Shared form field schemas for inventory-related forms.
 *
 * These schemas are used across multiple forms to ensure consistent validation
 * and reduce duplication. They handle combobox selection validation and amount fields.
 */
import { z } from "zod";
import { ComboboxItem } from "~/app/_components/combobox/combobox-types";
import { amount } from "~/codec/codec";

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

/**
 * Amount field schema (value + unit).
 * Re-exported from codec for convenience.
 */
export const amountField = amount;

/**
 * Schema for a single inventory item with product and amount.
 * Used in forms where location is set at the form level (e.g., bulk-inventory-form).
 */
export const inventoryItemFields = z.object({
  product: requiredProductField,
  amount: amountField,
});

/**
 * Schema for a single inventory item with product, location, and amount.
 * Used in forms where each item has its own location (e.g., quick-capture-form).
 */
export const inventoryItemWithLocationFields = z.object({
  product: requiredProductField,
  location: requiredLocationField,
  amount: amountField,
});

/**
 * Internal types for CSV import processing
 */

import type { ProductChangesPreview } from "@cubby/schemas/inventory";
import type { ProductTopLevelOut } from "@cubby/schemas/product";

/**
 * Result of previewing product changes for a CSV row
 */
export interface ProductPreviewResult {
  existingProduct: ProductTopLevelOut | null;
  productWillBeCreated: boolean;
  productChanges: ProductChangesPreview;
}

/**
 * Result of checking inventory at a target location
 */
export interface InventoryMatchResult {
  exists: boolean;
  matches: boolean;
  currentAmount?: { value: number; unit: string };
}

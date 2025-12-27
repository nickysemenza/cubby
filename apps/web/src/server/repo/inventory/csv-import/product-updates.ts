/**
 * Shared product update computation
 *
 * Single source of truth for determining what product fields should be updated
 * during CSV/sync import. Used by both preview (dry-run) and execution modes.
 */

import type { IngredientId } from "~/schemas/identifiers";
import type { ProductChangesPreview } from "~/schemas/inventory";
import type { ProductTopLevelOut, ProductCategory } from "~/schemas/product";

/**
 * Input data from CSV row for computing product updates
 */
export interface ProductUpdateInput {
  manufacturer: string;
  upc: string | undefined;
  expectedQty: number | null | undefined;
  model: string | undefined;
  ndbNumber: number | undefined;
  category: ProductCategory | null | undefined;
  /** Resolved ingredient ID (caller must resolve from name) */
  ingredientId: IngredientId | null;
  /** Ingredient name for display in preview */
  ingredientName: string | null;
}

/**
 * Database update values (for execution)
 */
export interface ProductUpdateValues {
  manufacturer?: string;
  upc?: string | null;
  expectedQuantity?: number;
  ingredientId?: IngredientId | null;
  model?: string | null;
  ndb_number?: number | null;
  category?: ProductCategory | null;
}

/**
 * Result of computing product updates
 */
export interface ComputedProductUpdates {
  /** Values to apply to database (empty object = no updates) */
  updates: ProductUpdateValues;
  /** Preview changes for UI display */
  changes: ProductChangesPreview;
  /** Whether any updates would be applied */
  hasUpdates: boolean;
}

/**
 * Compute what product updates should be applied
 *
 * This is the single source of truth for product field update logic.
 * Both preview and execution use this function to ensure consistency.
 *
 * Update rules:
 * - Manufacturer: allow any change (bidirectional)
 * - UPC, model, ndb_number, expectedQty: update if CSV provides non-null value
 * - Category: update if CSV provides value (including null)
 * - Ingredient: allow changing to different ingredient, but not unlinking (blank = keep existing)
 */
export const computeProductUpdates = (
  existingProduct: ProductTopLevelOut,
  input: ProductUpdateInput,
  existingIngredientId: string | null,
): ComputedProductUpdates => {
  const updates: ProductUpdateValues = {};
  const changes: ProductChangesPreview = {};

  // Manufacturer: allow any change (bidirectional)
  if (input.manufacturer !== existingProduct.manufacturer) {
    updates.manufacturer = input.manufacturer;
    changes.manufacturerWillBeSet = input.manufacturer;
    changes.manufacturerCurrent = existingProduct.manufacturer;
  }

  // UPC: update if provided and different
  if (input.upc != null && existingProduct.upc !== input.upc) {
    updates.upc = input.upc;
    changes.upcWillBeSet = input.upc;
    changes.upcCurrent = existingProduct.upc;
  }

  // Expected quantity: update if provided and different
  if (
    input.expectedQty != null &&
    existingProduct.expectedQuantity !== input.expectedQty
  ) {
    updates.expectedQuantity = input.expectedQty;
    changes.expectedQuantityWillBeSet = input.expectedQty;
    changes.expectedQuantityCurrent = existingProduct.expectedQuantity;
  }

  // Model: update if provided and different
  if (input.model != null && existingProduct.model !== input.model) {
    updates.model = input.model;
    changes.modelWillBeSet = input.model;
    changes.modelCurrent = existingProduct.model;
  }

  // NDB number: update if provided and different
  if (
    input.ndbNumber != null &&
    existingProduct.ndb_number !== input.ndbNumber
  ) {
    updates.ndb_number = input.ndbNumber;
    changes.ndbNumberWillBeSet = input.ndbNumber;
    changes.ndbNumberCurrent = existingProduct.ndb_number;
  }

  // Category: update if provided (including null) and different
  if (
    input.category !== undefined &&
    existingProduct.category !== input.category
  ) {
    updates.category = input.category;
    changes.categoryWillBeSet = input.category ?? undefined;
    changes.categoryCurrent = existingProduct.category;
  }

  // Ingredient: allow changing to different ingredient, but not unlinking
  // (if CSV has ingredient, update; if CSV is blank, keep existing)
  if (
    input.ingredientId != null &&
    input.ingredientId !== existingIngredientId
  ) {
    updates.ingredientId = input.ingredientId;
    changes.ingredientWillBeLinked = input.ingredientName ?? undefined;
    changes.ingredientCurrent = existingIngredientId;
  }

  return {
    updates,
    changes,
    hasUpdates: Object.keys(updates).length > 0,
  };
};

/**
 * Build preview for a new product (will be created)
 *
 * Returns changes showing what will be set (no "current" values)
 */
export const computeNewProductChanges = (
  input: ProductUpdateInput,
): ProductChangesPreview => {
  const changes: ProductChangesPreview = {};

  if (input.upc) {
    changes.upcWillBeSet = input.upc;
  }
  if (input.expectedQty != null) {
    changes.expectedQuantityWillBeSet = input.expectedQty;
  }
  if (input.ingredientName) {
    changes.ingredientWillBeLinked = input.ingredientName;
  }
  if (input.model) {
    changes.modelWillBeSet = input.model;
  }
  if (input.ndbNumber != null) {
    changes.ndbNumberWillBeSet = input.ndbNumber;
  }
  if (input.category) {
    changes.categoryWillBeSet = input.category;
  }

  return changes;
};

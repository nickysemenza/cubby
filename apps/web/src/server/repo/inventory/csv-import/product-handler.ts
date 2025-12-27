/**
 * Product handling functions for CSV import
 *
 * Handles product creation, updates, and preview logic.
 */

import { eq } from "drizzle-orm";
import type { ActorContext } from "~/schemas/context";
import {
  type IngredientId,
  type OrganizationId,
  unsafeIngredientId,
} from "~/schemas/identifiers";
import {
  hasFoodIndicators,
  type ProductCategory,
  type ProductTopLevelOut,
} from "~/schemas/product";
import type { Database } from "~/server/db";
import { product } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { applyUpdates, buildAuditChanges } from "~/server/repo/csv/field-utils";
import { getDb } from "~/server/repo/database-helpers";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import {
  findProductByNameFuzzyManufacturer,
  quickCreateProduct,
} from "~/server/repo/product";
import {
  computeNewProductChanges,
  computeProductUpdates,
  type ProductUpdateInput,
} from "./product-updates";
import type { ProductPreviewResult } from "./types";

/**
 * Parse semicolon-separated aliases string into array
 * @lintignore exported for testing
 */
export const parseAliasesString = (
  aliasesStr: string | null | undefined,
): string[] => {
  if (!aliasesStr) return [];
  return aliasesStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
};

/**
 * Find aliases that are new (don't exist in current set)
 * Comparison is case-insensitive
 * @lintignore exported for testing
 */
export const findNewAliases = (
  newAliases: string[],
  existingAliases: string[],
): string[] => {
  const existingLower = new Set(existingAliases.map((a) => a.toLowerCase()));
  return newAliases.filter((a) => !existingLower.has(a.toLowerCase()));
};

/**
 * Result of processing a product for import
 */
export interface ProcessProductResult {
  productData: ProductTopLevelOut;
  productWasCreated: boolean;
}

/**
 * Process a product for CSV import (find, create, or update)
 *
 * Handles:
 * - Finding existing products by name/manufacturer
 * - Creating new products with all CSV fields
 * - Updating existing products with new data from CSV
 * - Creating/linking ingredients when specified
 */
export const processProductForImport = async (
  db: Database,
  organizationId: OrganizationId,
  productName: string,
  manufacturer: string,
  upc: string | undefined,
  expectedQty: number | null | undefined,
  ingredientName: string | null | undefined,
  ingredientFlag: boolean | undefined,
  model: string | undefined,
  ndbNumber: number | undefined,
  aliasesStr: string | null | undefined,
  category: ProductCategory | null | undefined,
  actor: ActorContext,
): Promise<ProcessProductResult> => {
  // Parse aliases from semicolon-separated string
  const aliases = parseAliasesString(aliasesStr);

  // Determine ingredient name: explicit name takes precedence, then ingredient flag uses product name
  const effectiveIngredientName =
    ingredientName ?? (ingredientFlag ? productName : null);

  // If ingredient should be linked, find or create it with aliases
  let ingredientId: IngredientId | null = null;
  if (effectiveIngredientName) {
    const ingredientData = await findOrCreateIngredient(
      db,
      effectiveIngredientName,
      aliases.length > 0 ? aliases : undefined,
      organizationId,
    );
    ingredientId = unsafeIngredientId(ingredientData.id);
  }

  // Try to find existing product by name with fuzzy manufacturer matching
  // This allows sheet rows with "(unspecified)" to match existing products
  const existingProductData = await findProductByNameFuzzyManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  let productData: ProductTopLevelOut;
  let productWasCreated = false;

  if (!existingProductData) {
    // Create new product with all fields from CSV
    productWasCreated = true;
    productData = await quickCreateProduct(
      db,
      {
        name: productName,
        manufacturer,
        upc: upc ?? null,
        expectedQuantity: expectedQty ?? null,
        model: model ?? null,
        ndb_number: ndbNumber ?? null,
        ingredientId,
        category: category ?? null,
      },
      actor,
    );
  } else {
    productData = existingProductData;

    // Query existing ingredient link for update computation
    const existingProduct = await getDb(db).query.product.findFirst({
      where: eq(product.id, productData.id),
      columns: { ingredientId: true },
    });
    const existingIngredientId = existingProduct?.ingredientId ?? null;

    // Build input for shared update computation
    const updateInput: ProductUpdateInput = {
      manufacturer,
      upc,
      expectedQty,
      model,
      ndbNumber,
      category,
      ingredientId,
      ingredientName: effectiveIngredientName,
    };

    // Compute updates using shared logic
    const { updates, hasUpdates } = computeProductUpdates(
      productData,
      updateInput,
      existingIngredientId,
    );

    // Auto-correct category to "food" if the resulting product will have food indicators
    const resultingProduct = {
      ndb_number: updates.ndb_number ?? productData.ndb_number,
      ingredientId: updates.ingredientId ?? existingIngredientId,
    };
    if (
      hasFoodIndicators(resultingProduct) &&
      productData.category !== "food" &&
      updates.category === undefined
    ) {
      updates.category = "food";
    }

    if (hasUpdates || updates.category !== undefined) {
      // Capture before state for audit log
      const beforeState = {
        manufacturer: productData.manufacturer,
        upc: productData.upc,
        expectedQuantity: productData.expectedQuantity,
        model: productData.model,
        ndb_number: productData.ndb_number,
        ingredientId: existingIngredientId,
        category: productData.category,
      };

      await getDb(db)
        .update(product)
        .set(updates)
        .where(eq(product.id, productData.id));

      // Build and log audit entry
      const changes = buildAuditChanges(beforeState, updates);
      if (Object.keys(changes).length > 0) {
        await logAuditEntry(db, actor, {
          entityType: "product",
          entityId: productData.id,
          action: "update",
          changes,
        });
      }

      // Update local copy with changes
      productData = applyUpdates(productData, updates);
    }
  }

  return { productData, productWasCreated };
};

/**
 * Preview what would happen to a product without actually creating/updating it
 *
 * Used for dry-run mode to show users what changes will occur.
 * Captures both current values and proposed values for from→to display.
 *
 * Uses the same shared update logic as processProductForImport to ensure
 * preview accurately reflects what execution would do.
 */
export const previewProductForImport = async (
  db: Database,
  organizationId: OrganizationId,
  productName: string,
  manufacturer: string,
  upc: string | undefined,
  expectedQty: number | null | undefined,
  ingredientName: string | null | undefined,
  ingredientFlag: boolean | undefined,
  model: string | undefined,
  ndbNumber: number | undefined,
  aliasesStr: string | null | undefined,
  category: ProductCategory | null | undefined,
): Promise<ProductPreviewResult> => {
  const aliases = parseAliasesString(aliasesStr);
  const effectiveIngredientName =
    ingredientName ?? (ingredientFlag ? productName : null);

  // Use fuzzy matching to find existing product (consistent with actual import behavior)
  const existingProduct = await findProductByNameFuzzyManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  if (!existingProduct) {
    // Product will be created - use shared logic for new product preview
    const updateInput: ProductUpdateInput = {
      manufacturer,
      upc,
      expectedQty,
      model,
      ndbNumber,
      category,
      ingredientId: null, // Will be created during execution
      ingredientName: effectiveIngredientName,
    };

    const productChanges = computeNewProductChanges(updateInput);

    // Add aliases preview (handled separately from core updates)
    if (aliases.length > 0) {
      productChanges.aliasesWillBeAdded = aliases;
    }

    return {
      existingProduct: null,
      productWillBeCreated: true,
      productChanges,
    };
  }

  // Product exists - query ingredient link for update computation
  const productWithIngredient = await getDb(db).query.product.findFirst({
    where: eq(product.id, existingProduct.id),
    columns: { ingredientId: true },
    with: { Ingredient: { columns: { name: true, aliases: true } } },
  });
  const existingIngredientId = productWithIngredient?.ingredientId ?? null;

  // Build input for shared update computation
  // Note: ingredientId is null here since we don't resolve it in preview,
  // but ingredientName is set so the shared function can compute the change
  const updateInput: ProductUpdateInput = {
    manufacturer,
    upc,
    expectedQty,
    model,
    ndbNumber,
    category,
    ingredientId: effectiveIngredientName
      ? unsafeIngredientId("preview-placeholder")
      : null,
    ingredientName: effectiveIngredientName,
  };

  // Compute changes using shared logic
  const { changes: productChanges } = computeProductUpdates(
    existingProduct,
    updateInput,
    existingIngredientId,
  );

  // Check for new aliases - only show aliases that don't already exist
  if (aliases.length > 0) {
    const existingAliases = productWithIngredient?.Ingredient?.aliases ?? [];
    const newAliases = findNewAliases(aliases, existingAliases);

    if (newAliases.length > 0) {
      productChanges.aliasesWillBeAdded = newAliases;
      productChanges.aliasesCurrent =
        existingAliases.length > 0 ? existingAliases : undefined;
    }
  }

  return {
    existingProduct,
    productWillBeCreated: false,
    productChanges,
  };
};

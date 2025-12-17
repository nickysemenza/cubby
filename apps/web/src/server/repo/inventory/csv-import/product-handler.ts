/**
 * Product handling functions for CSV import
 *
 * Handles product creation, updates, and preview logic.
 */

import { type Database } from "~/server/db";
import {
  type OrganizationId,
  type IngredientId,
  unsafeIngredientId,
} from "~/schemas/identifiers";
import { type ProductChangesPreview } from "~/schemas/inventory";
import { getDb } from "~/server/repo/database-helpers";
import { product } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import {
  findProductByNameAndManufacturer,
  quickCreateProduct,
} from "~/server/repo/product";
import { type ProductTopLevelOut } from "~/schemas/product";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { type ProductPreviewResult } from "./types";

/**
 * Parse semicolon-separated aliases string into array
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
 * Find or create a product for CSV import
 *
 * Handles:
 * - Finding existing products by name/manufacturer
 * - Creating new products with all CSV fields
 * - Updating existing products with new data from CSV
 * - Creating/linking ingredients when specified
 */
export const findOrCreateProductForImport = async (
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
  userId: string,
): Promise<ProductTopLevelOut> => {
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

  // Try to find existing product by name+manufacturer (primary lookup)
  let productData = await findProductByNameAndManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  if (!productData) {
    // Create new product with all fields from CSV
    productData = await quickCreateProduct(
      db,
      {
        name: productName,
        manufacturer,
        upc: upc ?? null,
        expectedQuantity: expectedQty ?? 1,
        model: model ?? null,
        ndb_number: ndbNumber ?? null,
        ingredientId,
      },
      organizationId,
      userId,
    );
  } else {
    // Update existing product if CSV provides values
    const updates: {
      upc?: string | null;
      expectedQuantity?: number;
      ingredientId?: IngredientId | null;
      model?: string | null;
      ndb_number?: number | null;
    } = {};
    // Update UPC if provided and different
    if (upc != null && productData.upc !== upc) {
      updates.upc = upc;
    }
    if (expectedQty != null) {
      updates.expectedQuantity = expectedQty;
    }
    if (model != null) {
      updates.model = model;
    }
    if (ndbNumber != null) {
      updates.ndb_number = ndbNumber;
    }
    if (ingredientId != null) {
      // Check if product already has an ingredient linked (need to query DB)
      const existingProduct = await getDb(db).query.product.findFirst({
        where: eq(product.id, productData.id),
        columns: { ingredientId: true },
      });
      if (existingProduct?.ingredientId == null) {
        updates.ingredientId = ingredientId;
      }
    }

    if (Object.keys(updates).length > 0) {
      await getDb(db)
        .update(product)
        .set(updates)
        .where(eq(product.id, productData.id));
      // Update local copy for fields that might have changed
      if (updates.upc !== undefined) {
        productData = {
          ...productData,
          upc: updates.upc,
        };
      }
      if (updates.expectedQuantity != null) {
        productData = {
          ...productData,
          expectedQuantity: updates.expectedQuantity,
        };
      }
      if (updates.model != null) {
        productData = {
          ...productData,
          model: updates.model,
        };
      }
      if (updates.ndb_number != null) {
        productData = {
          ...productData,
          ndb_number: updates.ndb_number,
        };
      }
    }
  }

  return productData;
};

/**
 * Preview what would happen to a product without actually creating/updating it
 *
 * Used for dry-run mode to show users what changes will occur.
 * Captures both current values and proposed values for from→to display.
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
): Promise<ProductPreviewResult> => {
  const productChanges: ProductChangesPreview = {};
  const aliases = parseAliasesString(aliasesStr);
  const effectiveIngredientName =
    ingredientName ?? (ingredientFlag ? productName : null);

  const existingProduct = await findProductByNameAndManufacturer(
    db,
    productName,
    manufacturer,
    organizationId,
  );

  if (!existingProduct) {
    // Product will be created - show what will be set (no current values)
    if (upc) {
      productChanges.upcWillBeSet = upc;
    }
    if (expectedQty != null) {
      productChanges.expectedQuantityWillBeSet = expectedQty;
    }
    if (effectiveIngredientName) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
    }
    if (model) {
      productChanges.modelWillBeSet = model;
    }
    if (ndbNumber != null) {
      productChanges.ndbNumberWillBeSet = ndbNumber;
    }
    if (aliases.length > 0) {
      productChanges.aliasesWillBeAdded = aliases;
    }
    return {
      existingProduct: null,
      productWillBeCreated: true,
      productChanges,
    };
  }

  // Product exists - check what would be updated, capture current values
  if (upc && existingProduct.upc !== upc) {
    productChanges.upcWillBeSet = upc;
    productChanges.upcCurrent = existingProduct.upc;
  }

  if (expectedQty != null && existingProduct.expectedQuantity !== expectedQty) {
    productChanges.expectedQuantityWillBeSet = expectedQty;
    productChanges.expectedQuantityCurrent = existingProduct.expectedQuantity;
  }

  if (model && existingProduct.model !== model) {
    productChanges.modelWillBeSet = model;
    productChanges.modelCurrent = existingProduct.model;
  }

  if (ndbNumber != null && existingProduct.ndb_number !== ndbNumber) {
    productChanges.ndbNumberWillBeSet = ndbNumber;
    productChanges.ndbNumberCurrent = existingProduct.ndb_number;
  }

  // Check ingredient linking
  if (effectiveIngredientName) {
    const productWithIngredient = await getDb(db).query.product.findFirst({
      where: eq(product.id, existingProduct.id),
      columns: { ingredientId: true },
      with: { Ingredient: { columns: { name: true } } },
    });
    if (productWithIngredient?.ingredientId == null) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
    }
    productChanges.ingredientCurrent =
      productWithIngredient?.Ingredient?.name ?? null;
  }

  // Aliases will be added to ingredient if it's being linked
  if (aliases.length > 0 && effectiveIngredientName) {
    productChanges.aliasesWillBeAdded = aliases;
  }

  return {
    existingProduct,
    productWillBeCreated: false,
    productChanges,
  };
};

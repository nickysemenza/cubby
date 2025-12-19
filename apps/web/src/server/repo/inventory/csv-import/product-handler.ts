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
  findProductByNameFuzzyManufacturer,
  quickCreateProduct,
} from "~/server/repo/product";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { type ProductTopLevelOut } from "~/schemas/product";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { type ProductPreviewResult } from "./types";
import { logAuditEntry } from "~/server/repo/audit-log";
import { type ActorContext } from "~/schemas/context";

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
 * Find aliases that are new (don't exist in current set)
 * Comparison is case-insensitive
 */
export const findNewAliases = (
  newAliases: string[],
  existingAliases: string[],
): string[] => {
  const existingLower = new Set(existingAliases.map((a) => a.toLowerCase()));
  return newAliases.filter((a) => !existingLower.has(a.toLowerCase()));
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
  actor: ActorContext,
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

  // Try to find existing product by name with fuzzy manufacturer matching
  // This allows sheet rows with "(unspecified)" to match existing products
  let productData = await findProductByNameFuzzyManufacturer(
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
      actor,
    );
  } else {
    // Update existing product if CSV provides values
    const updates: {
      manufacturer?: string;
      upc?: string | null;
      expectedQuantity?: number;
      ingredientId?: IngredientId | null;
      model?: string | null;
      ndb_number?: number | null;
    } = {};

    // Update manufacturer if going from "(unspecified)" to a specific value
    const isCurrentUnspecified =
      productData.manufacturer.toLowerCase() ===
      UNSPECIFIED_MANUFACTURER.toLowerCase();
    const isNewSpecific =
      manufacturer &&
      manufacturer.toLowerCase() !== UNSPECIFIED_MANUFACTURER.toLowerCase();
    if (isCurrentUnspecified && isNewSpecific) {
      updates.manufacturer = manufacturer;
    }
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
    // Query existing ingredient link (needed for both updates and audit logging)
    let existingIngredientId: string | null = null;
    if (ingredientId != null) {
      // Check if product already has an ingredient linked (need to query DB)
      const existingProduct = await getDb(db).query.product.findFirst({
        where: eq(product.id, productData.id),
        columns: { ingredientId: true },
      });
      existingIngredientId = existingProduct?.ingredientId ?? null;
      if (existingIngredientId == null) {
        updates.ingredientId = ingredientId;
      }
    }

    if (Object.keys(updates).length > 0) {
      // Capture before state for audit log
      const beforeState = {
        manufacturer: productData.manufacturer,
        upc: productData.upc,
        expectedQuantity: productData.expectedQuantity,
        model: productData.model,
        ndb_number: productData.ndb_number,
        ingredientId: existingIngredientId,
      };

      await getDb(db)
        .update(product)
        .set(updates)
        .where(eq(product.id, productData.id));

      // Build changes for audit log
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (
        updates.manufacturer != null &&
        beforeState.manufacturer !== updates.manufacturer
      ) {
        changes.manufacturer = {
          from: beforeState.manufacturer,
          to: updates.manufacturer,
        };
      }
      if (updates.upc !== undefined && beforeState.upc !== updates.upc) {
        changes.upc = { from: beforeState.upc, to: updates.upc };
      }
      if (
        updates.expectedQuantity != null &&
        beforeState.expectedQuantity !== updates.expectedQuantity
      ) {
        changes.expectedQuantity = {
          from: beforeState.expectedQuantity,
          to: updates.expectedQuantity,
        };
      }
      if (updates.model != null && beforeState.model !== updates.model) {
        changes.model = { from: beforeState.model, to: updates.model };
      }
      if (
        updates.ndb_number != null &&
        beforeState.ndb_number !== updates.ndb_number
      ) {
        changes.ndb_number = {
          from: beforeState.ndb_number,
          to: updates.ndb_number,
        };
      }
      if (
        updates.ingredientId != null &&
        beforeState.ingredientId !== updates.ingredientId
      ) {
        changes.ingredientId = {
          from: beforeState.ingredientId,
          to: updates.ingredientId,
        };
      }

      // Log audit entry if there are changes
      if (Object.keys(changes).length > 0) {
        await logAuditEntry(db, actor, {
          entityType: "product",
          entityId: productData.id,
          action: "update",
          changes,
        });
      }

      // Update local copy for fields that might have changed
      if (updates.manufacturer != null) {
        productData = {
          ...productData,
          manufacturer: updates.manufacturer,
        };
      }
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

  // Use fuzzy matching to find existing product (consistent with actual import behavior)
  const existingProduct = await findProductByNameFuzzyManufacturer(
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

  // Check manufacturer update (from "(unspecified)" to specific)
  const isCurrentUnspecified =
    existingProduct.manufacturer.toLowerCase() ===
    UNSPECIFIED_MANUFACTURER.toLowerCase();
  const isNewSpecific =
    manufacturer &&
    manufacturer.toLowerCase() !== UNSPECIFIED_MANUFACTURER.toLowerCase();
  if (isCurrentUnspecified && isNewSpecific) {
    productChanges.manufacturerWillBeSet = manufacturer;
    productChanges.manufacturerCurrent = existingProduct.manufacturer;
  }

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

  // Check ingredient linking and aliases
  if (effectiveIngredientName) {
    const productWithIngredient = await getDb(db).query.product.findFirst({
      where: eq(product.id, existingProduct.id),
      columns: { ingredientId: true },
      with: { Ingredient: { columns: { name: true, aliases: true } } },
    });

    // Only set ingredient change if it's not already linked
    if (productWithIngredient?.ingredientId == null) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
      // Only set current when there's a change to show
      productChanges.ingredientCurrent = null;
    }

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
  }

  return {
    existingProduct,
    productWillBeCreated: false,
    productChanges,
  };
};

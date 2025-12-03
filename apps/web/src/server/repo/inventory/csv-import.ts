import { type Database } from "~/server/db";
import {
  type OrganizationId,
  type ProductId,
  type LocationId,
  type IngredientId,
  unsafeIngredientId,
} from "~/schemas/identifiers";
import {
  type InventoryCSVRow,
  type CSVImportResultItem,
  type ProductChangesPreview,
  type CSVImportResult,
} from "~/schemas/inventory";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import { getDb } from "~/server/repo/database-helpers";
import {
  product,
  inventoryEntry,
  productUnitMappings,
} from "~/server/db/schema";
import { eq, and } from "drizzle-orm";
import {
  findOrCreateLocationByPath,
  findLocationByPath,
} from "~/server/repo/location";
import {
  findProductByNameAndManufacturer,
  quickCreateProduct,
} from "~/server/repo/product";
import { type ProductTopLevelOut } from "~/schemas/product";
import { parseConversionString } from "~/schemas/config-parsers";
import { findOrCreateIngredient } from "~/server/repo/ingredient";
import { amount } from "~/codec/codec";
import { getTotalProductQuantity } from "./helpers";

// Helper: Parse semicolon-separated aliases string
const parseAliasesString = (
  aliasesStr: string | null | undefined,
): string[] => {
  if (!aliasesStr) return [];
  return aliasesStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
};

// Helper: Find or create product for CSV import
const findOrCreateProductForImport = async (
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
    );
  } else {
    // Update existing product if CSV provides values
    const updates: {
      expectedQuantity?: number;
      ingredientId?: IngredientId | null;
      model?: string | null;
      ndb_number?: number | null;
    } = {};
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

// Helper: Create or update price unit mapping for a product
export const createOrUpdatePriceMapping = async (
  db: Database,
  productId: ProductId,
  price: number,
  source: string = "csv-import",
): Promise<void> => {
  // Check if a price mapping already exists (1 each -> $X)
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  if (existingPriceMapping) {
    // Update existing price mapping
    await getDb(db)
      .update(productUnitMappings)
      .set({ b: { value: price, unit: "dollar" }, source })
      .where(eq(productUnitMappings.id, existingPriceMapping.id));
  } else {
    // Create new price mapping
    await getDb(db)
      .insert(productUnitMappings)
      .values({
        productId,
        a: { value: 1, unit: "each" },
        b: { value: price, unit: "dollar" },
        source,
      });
  }
};

// Helper: Create unit mappings from a semicolon-separated string
const createUnitMappingsFromString = async (
  db: Database,
  productId: ProductId,
  mappingsStr: string,
): Promise<void> => {
  // Parse "4 lb = $5; 1 cup = 120g" format
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of mappingParts) {
    try {
      const { from, to, source } = parseConversionString(part);
      await getDb(db)
        .insert(productUnitMappings)
        .values({
          productId,
          a: from,
          b: to,
          source: source ?? "csv-import",
        });
    } catch (e) {
      // Log warning but continue with other mappings
      console.warn(`Failed to parse unit mapping: ${part}`, e);
    }
  }
};

// Helper: Move inventory entries to new location
const moveInventoryEntries = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  if (existingEntries.length === 0) {
    return [];
  }

  // Delete existing entries
  for (const entry of existingEntries) {
    await getDb(db)
      .delete(inventoryEntry)
      .where(eq(inventoryEntry.id, entry.id));
  }

  // Check if already exists at target location
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (!existingAtTarget) {
    await getDb(db).insert(inventoryEntry).values({
      organizationId,
      productId,
      locationId: targetLocationId,
      amount: newAmount,
    });
  }

  return existingEntries.map((e) => e.location.name);
};

// Helper: Create or update inventory at target location
const createOrUpdateInventoryAtLocation = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
): Promise<"created" | "updated"> => {
  const existingAtTarget = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });

  if (existingAtTarget) {
    const existingAmount = amount.parse(existingAtTarget.amount);
    await getDb(db)
      .update(inventoryEntry)
      .set({
        amount: {
          value: existingAmount.value + newAmount.value,
          unit: newAmount.unit,
        },
      })
      .where(eq(inventoryEntry.id, existingAtTarget.id));
    return "updated";
  }

  await getDb(db).insert(inventoryEntry).values({
    organizationId,
    productId,
    locationId: targetLocationId,
    amount: newAmount,
  });
  return "created";
};

// Helper: Check what price mapping changes would occur (for preview)
const checkPriceMappingChanges = async (
  db: Database,
  productId: ProductId,
  newPrice: number,
): Promise<number | undefined> => {
  const existingMappings = await getDb(db).query.productUnitMappings.findMany({
    where: eq(productUnitMappings.productId, productId),
  });

  const existingPriceMapping = existingMappings.find(
    (m) => m.a.value === 1 && m.a.unit === "each" && m.b.unit === "dollar",
  );

  // Return the new price if it would be set or changed
  if (!existingPriceMapping || existingPriceMapping.b.value !== newPrice) {
    return newPrice;
  }
  return undefined;
};

// Helper: Parse unit mappings string and return count + details (for preview)
const parseUnitMappingsForPreview = (
  mappingsStr: string,
): { count: number; details: Array<{ from: string; to: string }> } => {
  const mappingParts = mappingsStr
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  const details = mappingParts.map((part) => {
    // Parse "1 stick = 113.4g" format
    const [from, to] = part.split("=").map((s) => s.trim());
    return { from: from ?? part, to: to ?? "" };
  });

  return { count: mappingParts.length, details };
};

// Helper: Preview what would happen for a product (without creating)
const previewProductForImport = async (
  db: Database,
  organizationId: OrganizationId,
  productName: string,
  manufacturer: string,
  expectedQty: number | null | undefined,
  ingredientName: string | null | undefined,
  ingredientFlag: boolean | undefined,
  model: string | undefined,
  ndbNumber: number | undefined,
  aliasesStr: string | null | undefined,
): Promise<{
  existingProduct: ProductTopLevelOut | null;
  productWillBeCreated: boolean;
  productChanges: ProductChangesPreview;
}> => {
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
    // Product will be created
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

  // Product exists - check what would be updated
  if (expectedQty != null && existingProduct.expectedQuantity !== expectedQty) {
    productChanges.expectedQuantityWillBeSet = expectedQty;
  }

  if (model && existingProduct.model !== model) {
    productChanges.modelWillBeSet = model;
  }

  if (ndbNumber != null && existingProduct.ndb_number !== ndbNumber) {
    productChanges.ndbNumberWillBeSet = ndbNumber;
  }

  // Check ingredient linking
  if (effectiveIngredientName) {
    const productWithIngredient = await getDb(db).query.product.findFirst({
      where: eq(product.id, existingProduct.id),
      columns: { ingredientId: true },
    });
    if (productWithIngredient?.ingredientId == null) {
      productChanges.ingredientWillBeLinked = effectiveIngredientName;
    }
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

// Helper: Get locations where a product currently exists (for move preview)
const getExistingInventoryLocations = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
): Promise<string[]> => {
  const existingEntries = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
    with: {
      location: true,
    },
  });

  return existingEntries.map((e) => e.location.name);
};

// Helper: Check if inventory already exists at target location and if quantity matches
const checkInventoryMatch = async (
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  targetLocationId: LocationId,
  expectedAmount: { value: number; unit: string },
): Promise<{ exists: boolean; matches: boolean }> => {
  const existing = await getDb(db).query.inventoryEntry.findFirst({
    where: and(
      eq(inventoryEntry.productId, productId),
      eq(inventoryEntry.locationId, targetLocationId),
      eq(inventoryEntry.organizationId, organizationId),
    ),
  });
  if (!existing) return { exists: false, matches: false };
  const existingAmount = amount.parse(existing.amount);
  const matches =
    existingAmount.value === expectedAmount.value &&
    existingAmount.unit === expectedAmount.unit;
  return { exists: true, matches };
};

// Import CSV data with smart move logic
// When dryRun=true, performs all lookups but no writes, returning what would happen
export const importInventoryFromCSV = async (
  db: Database,
  organizationId: OrganizationId,
  rows: InventoryCSVRow[],
  dryRun: boolean = false,
): Promise<CSVImportResult> => {
  const results: CSVImportResultItem[] = [];
  let created = 0;
  let moved = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  let productOnly = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;

      // Check if this is a product-only row (no location_path)
      const isProductOnly =
        !row.location_path || row.location_path.trim() === "";

      let productData: ProductTopLevelOut | null = null;
      let productWillBeCreated = false;
      let productChanges: ProductChangesPreview = {};

      if (dryRun) {
        // Preview mode: just check what would happen
        const preview = await previewProductForImport(
          db,
          organizationId,
          row.product_name,
          manufacturer,
          row.expected_qty,
          row.ingredient_name,
          row.ingredient,
          row.model,
          row.ndb_number,
          row.aliases,
        );
        productData = preview.existingProduct;
        productWillBeCreated = preview.productWillBeCreated;
        productChanges = preview.productChanges;

        // Check price changes if product exists and price provided
        if (row.price != null && productData) {
          const priceChange = await checkPriceMappingChanges(
            db,
            productData.id,
            row.price,
          );
          if (priceChange !== undefined) {
            productChanges.priceWillBeSet = priceChange;
          }
        } else if (row.price != null && productWillBeCreated) {
          // New product will get this price
          productChanges.priceWillBeSet = row.price;
        }

        // Parse unit mappings for preview (count and details)
        if (row.unit_mappings) {
          const mappings = parseUnitMappingsForPreview(row.unit_mappings);
          productChanges.unitMappingsWillBeAdded = mappings.count;
          productChanges.unitMappingsDetail = mappings.details;
        }
      } else {
        // Normal mode: actually create/update product
        productData = await findOrCreateProductForImport(
          db,
          organizationId,
          row.product_name,
          manufacturer,
          row.upc,
          row.expected_qty,
          row.ingredient_name,
          row.ingredient,
          row.model,
          row.ndb_number,
          row.aliases,
        );

        // Handle price mapping if provided
        if (row.price != null) {
          await createOrUpdatePriceMapping(db, productData.id, row.price);
        }

        // Handle unit mappings if provided
        if (row.unit_mappings) {
          await createUnitMappingsFromString(
            db,
            productData.id,
            row.unit_mappings,
          );
        }
      }

      // Handle product-only rows (no inventory placement)
      if (isProductOnly) {
        results.push({
          rowIndex: i,
          action: "product_only",
          productName: row.product_name,
          locationPath: undefined,
          message: productWillBeCreated
            ? "Product will be created"
            : "Product already exists",
          productWillBeCreated,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        productOnly++;
        continue;
      }

      // For rows with location_path, continue with inventory processing
      let targetLocationId: LocationId | null = null;
      let locationWillBeCreated = false;

      if (dryRun) {
        // Try to find location without creating
        targetLocationId = await findLocationByPath(
          db,
          organizationId,
          row.location_path!,
        );
        if (!targetLocationId) {
          locationWillBeCreated = true;
        }
      } else {
        targetLocationId = await findOrCreateLocationByPath(
          db,
          organizationId,
          row.location_path!,
        );
      }

      // For dryRun with no existing product, we know it will be "created"
      if (dryRun && productWillBeCreated) {
        results.push({
          rowIndex: i,
          action: "created",
          productName: row.product_name,
          locationPath: row.location_path,
          productWillBeCreated: true,
          locationWillBeCreated,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        created++;
        continue;
      }

      // For dryRun with no location found, check if this could be a MOVE before defaulting to "created"
      if (dryRun && !targetLocationId) {
        // Check move conditions: product has expectedQuantity and exists elsewhere
        if (productData && productData.expectedQuantity !== null) {
          const totalExistingQty = await getTotalProductQuantity(
            db,
            productData.id,
            organizationId,
          );

          if (totalExistingQty >= productData.expectedQuantity) {
            // This is a move to a new location
            const existingLocations = await getExistingInventoryLocations(
              db,
              organizationId,
              productData.id,
            );

            if (existingLocations.length > 0) {
              results.push({
                rowIndex: i,
                action: "moved",
                productName: row.product_name,
                locationPath: row.location_path,
                movedFrom: existingLocations,
                message: `Will move from ${existingLocations.join(", ")}`,
                productWillBeCreated,
                locationWillBeCreated: true,
                productChanges:
                  Object.keys(productChanges).length > 0
                    ? productChanges
                    : undefined,
              });
              moved++;
              continue;
            }
          }
        }

        // Not a move - it's a create with new location
        results.push({
          rowIndex: i,
          action: "created",
          productName: row.product_name,
          locationPath: row.location_path,
          productWillBeCreated,
          locationWillBeCreated: true,
          productChanges:
            Object.keys(productChanges).length > 0 ? productChanges : undefined,
        });
        created++;
        continue;
      }

      // At this point we have productData and targetLocationId
      if (!productData || !targetLocationId) {
        throw new Error("Unexpected state: missing product or location data");
      }

      const newAmount = { value: row.quantity, unit: row.unit };

      // Check if inventory exists at target and if it matches
      const inventoryCheck = await checkInventoryMatch(
        db,
        organizationId,
        productData.id,
        targetLocationId,
        newAmount,
      );

      // Get total existing quantity for move logic
      const totalExistingQty = await getTotalProductQuantity(
        db,
        productData.id,
        organizationId,
      );

      // Smart move logic: if at expected capacity and NOT already at target, move instead of adding
      const shouldMove =
        productData.expectedQuantity !== null &&
        totalExistingQty >= productData.expectedQuantity;

      // Check if product is ONLY at the target location (don't move if already there)
      const existingLocations = shouldMove
        ? await getExistingInventoryLocations(
            db,
            organizationId,
            productData.id,
          )
        : [];
      const isOnlyAtTarget =
        existingLocations.length === 1 && inventoryCheck.exists;

      if (shouldMove && !isOnlyAtTarget && existingLocations.length > 0) {
        if (dryRun) {
          // Preview: show where it would move from
          results.push({
            rowIndex: i,
            action: "moved",
            productName: row.product_name,
            locationPath: row.location_path,
            movedFrom: existingLocations,
            message: `Will move from ${existingLocations.join(", ")}`,
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          moved++;
          continue;
        } else {
          // Actually perform the move
          const fromLocations = await moveInventoryEntries(
            db,
            organizationId,
            productData.id,
            targetLocationId,
            newAmount,
          );

          if (fromLocations.length > 0) {
            results.push({
              rowIndex: i,
              action: "moved",
              productName: row.product_name,
              locationPath: row.location_path,
              movedFrom: fromLocations,
              message: `Moved from ${fromLocations.join(", ")}`,
            });
            moved++;
            continue;
          }
        }
      }

      // Check for skip (exact match) or update (exists but different quantity)
      if (dryRun) {
        if (inventoryCheck.matches) {
          // Exact match - skip (but may still have product changes)
          results.push({
            rowIndex: i,
            action: "skipped",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Already exists with same quantity",
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          skipped++;
        } else if (inventoryCheck.exists) {
          // Exists but quantity differs - would be updated
          results.push({
            rowIndex: i,
            action: "updated",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Will update quantity",
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          updated++;
        } else {
          // Doesn't exist - would be created
          results.push({
            rowIndex: i,
            action: "created",
            productName: row.product_name,
            locationPath: row.location_path,
            productWillBeCreated,
            locationWillBeCreated,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          });
          created++;
        }
      } else {
        // Actually create or update inventory
        if (inventoryCheck.matches) {
          // Exact match - skip
          results.push({
            rowIndex: i,
            action: "skipped",
            productName: row.product_name,
            locationPath: row.location_path,
            message: "Already exists with same quantity",
          });
          skipped++;
        } else {
          const action = await createOrUpdateInventoryAtLocation(
            db,
            organizationId,
            productData.id,
            targetLocationId,
            newAmount,
          );

          if (action === "updated") {
            results.push({
              rowIndex: i,
              action: "updated",
              productName: row.product_name,
              locationPath: row.location_path,
              message: "Updated existing entry quantity",
            });
            updated++;
          } else {
            results.push({
              rowIndex: i,
              action: "created",
              productName: row.product_name,
              locationPath: row.location_path,
            });
            created++;
          }
        }
      }
    } catch (error) {
      results.push({
        rowIndex: i,
        action: "error",
        productName: row.product_name,
        locationPath: row.location_path,
        message: error instanceof Error ? error.message : "Unknown error",
      });
      errors++;
    }
  }

  return {
    created,
    moved,
    updated,
    skipped,
    errors,
    productOnly,
    items: results,
  };
};

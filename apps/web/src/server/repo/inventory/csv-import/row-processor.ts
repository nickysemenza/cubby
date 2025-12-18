/**
 * Row processor for CSV import
 *
 * Handles processing a single CSV row, both for dry-run preview and actual execution.
 */

import { type Database } from "~/server/db";
import { type OrganizationId, type LocationId } from "~/schemas/identifiers";
import {
  type InventoryCSVRow,
  type CSVImportResultItem,
  type ProductChangesPreview,
  type FieldChange,
} from "~/schemas/inventory";
import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import {
  findLocationByPath,
  findOrCreateLocationByPathWithContext,
  type LocationTypeContext,
} from "~/server/repo/location";
import { type ProductTopLevelOut } from "~/schemas/product";
import { getTotalProductQuantity } from "../helpers";
import {
  findOrCreateProductForImport,
  previewProductForImport,
} from "./product-handler";
import {
  createOrUpdatePriceMapping,
  createUnitMappingsFromString,
  checkPriceMappingChanges,
  parseUnitMappingsForPreview,
} from "./unit-mapping-handler";
import {
  moveInventoryEntries,
  createOrUpdateInventoryAtLocation,
  getExistingInventoryLocations,
  checkInventoryMatch,
} from "./inventory-handler";
import { type ActorContext } from "~/schemas/context";

interface RowProcessorContext {
  db: Database;
  organizationId: OrganizationId;
  locationTypeContext: LocationTypeContext;
  dryRun: boolean;
  actor: ActorContext;
}

/**
 * Convert ProductChangesPreview to FieldChange[] for consistent display
 */
function productChangesToFieldChanges(
  changes: ProductChangesPreview,
): FieldChange[] {
  const result: FieldChange[] = [];

  if (changes.upcWillBeSet !== undefined) {
    result.push({
      field: "upc",
      from: changes.upcCurrent ?? null,
      to: changes.upcWillBeSet,
    });
  }
  if (changes.modelWillBeSet !== undefined) {
    result.push({
      field: "model",
      from: changes.modelCurrent ?? null,
      to: changes.modelWillBeSet,
    });
  }
  if (changes.ndbNumberWillBeSet !== undefined) {
    result.push({
      field: "ndb",
      from: changes.ndbNumberCurrent ?? null,
      to: changes.ndbNumberWillBeSet,
    });
  }
  if (changes.expectedQuantityWillBeSet !== undefined) {
    result.push({
      field: "expected",
      from: changes.expectedQuantityCurrent ?? null,
      to: changes.expectedQuantityWillBeSet,
    });
  }
  if (changes.priceWillBeSet !== undefined) {
    result.push({
      field: "price",
      from: changes.priceCurrent ?? null,
      to: changes.priceWillBeSet,
    });
  }
  if (changes.ingredientWillBeLinked !== undefined) {
    result.push({
      field: "ingredient",
      from: changes.ingredientCurrent ?? null,
      to: changes.ingredientWillBeLinked,
    });
  }
  if (
    changes.unitMappingsWillBeAdded !== undefined &&
    changes.unitMappingsWillBeAdded > 0
  ) {
    // Format unit mappings as readable string
    const newMappings = changes.unitMappingsDetail
      ?.map((d) => `${d.from} = ${d.to}`)
      .join("; ");
    result.push({
      field: "unit_mappings",
      from: changes.unitMappingsCurrent ?? null,
      to: newMappings ?? `${changes.unitMappingsWillBeAdded} mappings`,
    });
  }
  if (
    changes.aliasesWillBeAdded !== undefined &&
    changes.aliasesWillBeAdded.length > 0
  ) {
    result.push({
      field: "aliases",
      from: changes.aliasesCurrent?.join("; ") ?? null,
      to: changes.aliasesWillBeAdded.join("; "),
    });
  }

  return result;
}

/**
 * Build fieldChanges array from productChanges and optional inventory changes
 */
function buildFieldChanges(
  productChanges: ProductChangesPreview,
  inventoryFieldChanges?: FieldChange[],
): FieldChange[] | undefined {
  const productFields = productChangesToFieldChanges(productChanges);
  const allChanges = [...(inventoryFieldChanges ?? []), ...productFields];
  return allChanges.length > 0 ? allChanges : undefined;
}

/**
 * Process a single CSV row for import
 *
 * Handles both preview (dry-run) and actual execution modes.
 */
export const processRow = async (
  ctx: RowProcessorContext,
  row: InventoryCSVRow,
  rowIndex: number,
): Promise<CSVImportResultItem> => {
  const { db, organizationId, locationTypeContext, dryRun, actor } = ctx;
  const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;

  // Check if this is a product-only row (no location_path)
  const isProductOnly = !row.location_path || row.location_path.trim() === "";

  let productData: ProductTopLevelOut | null = null;
  let productWillBeCreated = false;
  let productChanges: ProductChangesPreview = {};

  // Handle product creation/update
  if (dryRun) {
    const preview = await previewProductForImport(
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
    productData = preview.existingProduct;
    productWillBeCreated = preview.productWillBeCreated;
    productChanges = preview.productChanges;

    // Check price changes (CSV price is numeric, defaults to dollar)
    if (row.price != null && productData) {
      const priceChange = await checkPriceMappingChanges(db, productData.id, {
        value: row.price,
        unit: "dollar",
      });
      if (priceChange !== undefined) {
        productChanges.priceWillBeSet = priceChange;
      }
    } else if (row.price != null && productWillBeCreated) {
      productChanges.priceWillBeSet = row.price;
    }

    // Parse unit mappings for preview using WASM
    if (row.unit_mappings) {
      const mappings = await parseUnitMappingsForPreview(row.unit_mappings);
      productChanges.unitMappingsWillBeAdded = mappings.count;
      productChanges.unitMappingsDetail = mappings.details;
    }
  } else {
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
      actor,
    );

    // Handle price mapping (CSV price is numeric, defaults to dollar)
    if (row.price != null) {
      await createOrUpdatePriceMapping(db, productData.id, {
        value: row.price,
        unit: "dollar",
      });
    }

    // Handle unit mappings
    if (row.unit_mappings) {
      await createUnitMappingsFromString(db, productData.id, row.unit_mappings);
    }
  }

  // Handle product-only rows (no inventory placement)
  if (isProductOnly) {
    return {
      rowIndex,
      action: "product_only",
      productName: row.product_name,
      productId: productData?.id,
      upc: row.upc,
      locationPath: undefined,
      message: productWillBeCreated
        ? "Product will be created"
        : "Product already exists",
      fieldChanges: buildFieldChanges(productChanges),
      productWillBeCreated,
      productChanges:
        Object.keys(productChanges).length > 0 ? productChanges : undefined,
    };
  }

  // For rows with location_path, continue with inventory processing
  let targetLocationId: LocationId | null = null;
  let locationWillBeCreated = false;

  if (dryRun) {
    targetLocationId = await findLocationByPath(
      db,
      organizationId,
      row.location_path!,
    );
    if (!targetLocationId) {
      locationWillBeCreated = true;
    }
  } else {
    targetLocationId = await findOrCreateLocationByPathWithContext(
      db,
      organizationId,
      row.location_path!,
      locationTypeContext,
    );
  }

  const newAmount = { value: row.quantity, unit: row.unit };

  // Handle dry-run with new product
  if (dryRun && productWillBeCreated) {
    return {
      rowIndex,
      action: "created",
      productName: row.product_name,
      locationPath: row.location_path,
      locationId: targetLocationId ?? undefined,
      fieldChanges: buildFieldChanges(productChanges),
      productWillBeCreated: true,
      locationWillBeCreated,
      productChanges:
        Object.keys(productChanges).length > 0 ? productChanges : undefined,
    };
  }

  // Handle dry-run with no location found - check if this is a move
  if (dryRun && !targetLocationId) {
    if (productData && productData.expectedQuantity !== null) {
      const totalExistingQty = await getTotalProductQuantity(
        db,
        productData.id,
        organizationId,
      );

      if (totalExistingQty >= productData.expectedQuantity) {
        const existingLocations = await getExistingInventoryLocations(
          db,
          organizationId,
          productData.id,
        );

        if (existingLocations.length > 0) {
          return {
            rowIndex,
            action: "moved",
            productName: row.product_name,
            locationPath: row.location_path,
            locationId: undefined, // Location will be created
            movedFrom: existingLocations,
            message: `Will move from ${existingLocations.join(", ")}`,
            fieldChanges: buildFieldChanges(productChanges),
            productWillBeCreated,
            locationWillBeCreated: true,
            productChanges:
              Object.keys(productChanges).length > 0
                ? productChanges
                : undefined,
          };
        }
      }
    }

    // Not a move - it's a create with new location
    return {
      rowIndex,
      action: "created",
      productName: row.product_name,
      locationPath: row.location_path,
      locationId: undefined, // Location will be created
      fieldChanges: buildFieldChanges(productChanges),
      productWillBeCreated,
      locationWillBeCreated: true,
      productChanges:
        Object.keys(productChanges).length > 0 ? productChanges : undefined,
    };
  }

  // At this point we should have productData and targetLocationId
  if (!productData || !targetLocationId) {
    throw new Error("Unexpected state: missing product or location data");
  }

  // Check inventory state at target
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
    ? await getExistingInventoryLocations(db, organizationId, productData.id)
    : [];
  const isOnlyAtTarget =
    existingLocations.length === 1 && inventoryCheck.exists;

  // Handle move case
  if (shouldMove && !isOnlyAtTarget && existingLocations.length > 0) {
    if (dryRun) {
      return {
        rowIndex,
        action: "moved",
        productName: row.product_name,
        locationPath: row.location_path,
        locationId: targetLocationId,
        movedFrom: existingLocations,
        message: `Will move from ${existingLocations.join(", ")}`,
        fieldChanges: buildFieldChanges(productChanges),
        productWillBeCreated,
        locationWillBeCreated,
        productChanges:
          Object.keys(productChanges).length > 0 ? productChanges : undefined,
      };
    } else {
      const fromLocations = await moveInventoryEntries(
        db,
        organizationId,
        productData.id,
        targetLocationId,
        newAmount,
      );

      if (fromLocations.length > 0) {
        return {
          rowIndex,
          action: "moved",
          productName: row.product_name,
          productId: productData.id,
          upc: row.upc,
          locationPath: row.location_path,
          locationId: targetLocationId,
          movedFrom: fromLocations,
          message: `Moved from ${fromLocations.join(", ")}`,
        };
      }
    }
  }

  // Handle skip/update/create cases
  if (dryRun) {
    if (inventoryCheck.matches) {
      // Even if inventory matches, product fields might change
      const productFieldChanges = buildFieldChanges(productChanges);
      return {
        rowIndex,
        action: productFieldChanges ? "updated" : "skipped",
        productName: row.product_name,
        locationPath: row.location_path,
        locationId: targetLocationId,
        message: productFieldChanges
          ? undefined
          : "Already exists with same quantity",
        fieldChanges: productFieldChanges,
        productWillBeCreated,
        locationWillBeCreated,
        productChanges:
          Object.keys(productChanges).length > 0 ? productChanges : undefined,
      };
    } else if (inventoryCheck.exists) {
      // Build structured field changes for quantity update
      const currentAmt = inventoryCheck.currentAmount;
      const inventoryFieldChanges: FieldChange[] = currentAmt
        ? [
            {
              field: "qty",
              from: `${currentAmt.value} ${currentAmt.unit}`,
              to: `${newAmount.value} ${newAmount.unit}`,
            },
          ]
        : [];

      return {
        rowIndex,
        action: "updated",
        productName: row.product_name,
        locationPath: row.location_path,
        locationId: targetLocationId,
        fieldChanges: buildFieldChanges(productChanges, inventoryFieldChanges),
        productWillBeCreated,
        locationWillBeCreated,
        productChanges:
          Object.keys(productChanges).length > 0 ? productChanges : undefined,
      };
    } else {
      return {
        rowIndex,
        action: "created",
        productName: row.product_name,
        locationPath: row.location_path,
        locationId: targetLocationId,
        fieldChanges: buildFieldChanges(productChanges),
        productWillBeCreated,
        locationWillBeCreated,
        productChanges:
          Object.keys(productChanges).length > 0 ? productChanges : undefined,
      };
    }
  } else {
    // Actually create or update inventory
    if (inventoryCheck.matches) {
      return {
        rowIndex,
        action: "skipped",
        productName: row.product_name,
        productId: productData.id,
        upc: row.upc,
        locationPath: row.location_path,
        locationId: targetLocationId,
        message: "Already exists with same quantity",
      };
    } else {
      const action = await createOrUpdateInventoryAtLocation(
        db,
        organizationId,
        productData.id,
        targetLocationId,
        newAmount,
      );

      if (action === "updated") {
        return {
          rowIndex,
          action: "updated",
          productName: row.product_name,
          productId: productData.id,
          upc: row.upc,
          locationPath: row.location_path,
          locationId: targetLocationId,
          message: "Updated existing entry quantity",
        };
      } else {
        return {
          rowIndex,
          action: "created",
          productName: row.product_name,
          productId: productData.id,
          upc: row.upc,
          locationPath: row.location_path,
          locationId: targetLocationId,
        };
      }
    }
  }
};

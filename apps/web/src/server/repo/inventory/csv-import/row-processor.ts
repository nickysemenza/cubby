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

interface RowProcessorContext {
  db: Database;
  organizationId: OrganizationId;
  locationTypeContext: LocationTypeContext;
  dryRun: boolean;
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
  const { db, organizationId, locationTypeContext, dryRun } = ctx;
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
            movedFrom: existingLocations,
            message: `Will move from ${existingLocations.join(", ")}`,
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
        movedFrom: existingLocations,
        message: `Will move from ${existingLocations.join(", ")}`,
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
          movedFrom: fromLocations,
          message: `Moved from ${fromLocations.join(", ")}`,
        };
      }
    }
  }

  // Handle skip/update/create cases
  if (dryRun) {
    if (inventoryCheck.matches) {
      return {
        rowIndex,
        action: "skipped",
        productName: row.product_name,
        locationPath: row.location_path,
        message: "Already exists with same quantity",
        productWillBeCreated,
        locationWillBeCreated,
        productChanges:
          Object.keys(productChanges).length > 0 ? productChanges : undefined,
      };
    } else if (inventoryCheck.exists) {
      // Build message showing quantity change
      const currentAmt = inventoryCheck.currentAmount;
      const qtyMessage = currentAmt
        ? `qty: ${currentAmt.value} ${currentAmt.unit} → ${newAmount.value} ${newAmount.unit}`
        : "Will update quantity";

      return {
        rowIndex,
        action: "updated",
        productName: row.product_name,
        locationPath: row.location_path,
        message: qtyMessage,
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
        };
      }
    }
  }
};

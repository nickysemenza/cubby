/**
 * Row processor for CSV import
 *
 * Handles processing a single CSV row, both for dry-run preview and actual execution.
 */

import { UNSPECIFIED_MANUFACTURER } from "~/lib/constants";
import type { ActorContext } from "~/schemas/context";
import type { FieldChange } from "~/schemas/csv";
import type { LocationId, ProductId } from "~/schemas/identifiers";
import type {
  CSVImportResultItem,
  InventoryCSVRow,
  ProductChangesPreview,
} from "~/schemas/inventory";
import type { ProductTopLevelOut } from "~/schemas/product";
import type { Database } from "~/server/db";
import { parseCSVDate } from "~/server/repo/csv/date-utils";
import {
  findLocationByName,
  findLocationByShortcode,
  findOrCreateLocationByName,
} from "~/server/repo/location";
import { SYNC_TIMESTAMPS } from "~/server/repo/sync/config";
import { importProductImages, previewProductImages } from "./image-handler";
import {
  checkInventoryMatch,
  createOrUpdateInventoryAtLocation,
  getExistingInventoryLocations,
  type InventoryTimestamps,
  moveInventoryEntries,
} from "./inventory-handler";
import {
  type ProductTimestamps,
  previewProductForImport,
  processProductForImport,
} from "./product-handler";
import {
  checkPriceMappingChanges,
  checkUnitMappingsChanges,
  createOrUpdatePriceMapping,
  createUnitMappingsFromString,
  parseUnitMappingsForPreview,
} from "./unit-mapping-handler";

interface RowProcessorContext {
  db: Database;
  dryRun: boolean;
  actor: ActorContext;
}

/**
 * Parse timestamps from CSV row if SYNC_TIMESTAMPS is enabled
 */
function parseRowTimestamps(row: InventoryCSVRow): {
  product: ProductTimestamps | undefined;
  inventory: InventoryTimestamps | undefined;
} {
  if (!SYNC_TIMESTAMPS) {
    return { product: undefined, inventory: undefined };
  }

  const product: ProductTimestamps = {};
  const inventory: InventoryTimestamps = {};

  if (row.product_created_at) {
    product.createdAt = parseCSVDate(row.product_created_at) ?? undefined;
  }
  if (row.product_updated_at) {
    product.updatedAt = parseCSVDate(row.product_updated_at) ?? undefined;
  }
  if (row.inventory_created_at) {
    inventory.createdAt = parseCSVDate(row.inventory_created_at) ?? undefined;
  }
  if (row.inventory_updated_at) {
    inventory.updatedAt = parseCSVDate(row.inventory_updated_at) ?? undefined;
  }

  return {
    product: Object.keys(product).length > 0 ? product : undefined,
    inventory: Object.keys(inventory).length > 0 ? inventory : undefined,
  };
}

/**
 * Helper to add a field change if the value is defined
 */
function addFieldChange(
  result: FieldChange[],
  field: string,
  willBeSet: unknown,
  current: unknown,
): void {
  if (willBeSet !== undefined) {
    result.push({ field, from: current ?? null, to: willBeSet });
  }
}

/**
 * Convert ProductChangesPreview to FieldChange[] for consistent display
 */
function productChangesToFieldChanges(
  changes: ProductChangesPreview,
): FieldChange[] {
  const result: FieldChange[] = [];

  // Simple field mappings
  addFieldChange(result, "upc", changes.upcWillBeSet, changes.upcCurrent);
  addFieldChange(result, "model", changes.modelWillBeSet, changes.modelCurrent);
  addFieldChange(
    result,
    "ndb",
    changes.ndbNumberWillBeSet,
    changes.ndbNumberCurrent,
  );
  addFieldChange(
    result,
    "expected",
    changes.expectedQuantityWillBeSet,
    changes.expectedQuantityCurrent,
  );
  addFieldChange(result, "price", changes.priceWillBeSet, changes.priceCurrent);
  addFieldChange(
    result,
    "ingredient",
    changes.ingredientWillBeLinked,
    changes.ingredientCurrent,
  );

  // Unit mappings need special formatting
  if (
    changes.unitMappingsWillBeAdded !== undefined &&
    changes.unitMappingsWillBeAdded > 0
  ) {
    const newMappings = changes.unitMappingsDetail
      ?.map((d) => `${d.from} = ${d.to}`)
      .join("; ");
    result.push({
      field: "unit_mappings",
      from: changes.unitMappingsCurrent ?? null,
      to: newMappings ?? `${changes.unitMappingsWillBeAdded} mappings`,
    });
  }

  // Aliases need array-to-string conversion
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
 * Check if productChanges has any entries
 */
function hasChanges(productChanges: ProductChangesPreview): boolean {
  return Object.keys(productChanges).length > 0;
}

/**
 * Wrap productChanges for result if non-empty
 */
function wrapChanges(
  productChanges: ProductChangesPreview,
): ProductChangesPreview | undefined {
  return hasChanges(productChanges) ? productChanges : undefined;
}

// ============================================================================
// Product Processing
// ============================================================================

interface ProductProcessingResult {
  productData: ProductTopLevelOut | null;
  productWillBeCreated: boolean;
  productChanges: ProductChangesPreview;
}

/**
 * Handle product preview - check what changes would occur without making them
 */
async function previewProduct(
  db: Database,
  row: InventoryCSVRow,
  manufacturer: string,
): Promise<ProductProcessingResult> {
  const preview = await previewProductForImport(
    db,
    row.product_name,
    manufacturer,
    row.upc,
    row.expected_qty,
    row.ingredient_name,
    row.ingredient,
    row.model,
    row.ndb_number,
    row.aliases,
    row.category,
    row.product_shortcode,
  );

  const productData = preview.existingProduct;
  const productWillBeCreated = preview.productWillBeCreated;
  const productChanges = { ...preview.productChanges };

  // Check price changes
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

  // Check unit mappings changes
  if (row.unit_mappings) {
    if (productData) {
      const mappingChanges = await checkUnitMappingsChanges(
        db,
        productData.id,
        row.unit_mappings,
      );
      if (mappingChanges) {
        productChanges.unitMappingsWillBeAdded = mappingChanges.willBeAdded;
        productChanges.unitMappingsDetail = mappingChanges.details;
        productChanges.unitMappingsCurrent = mappingChanges.current;
      }
    } else {
      const mappings = parseUnitMappingsForPreview(row.unit_mappings);
      productChanges.unitMappingsWillBeAdded = mappings.count;
      productChanges.unitMappingsDetail = mappings.details;
    }
  }

  // Check image import preview
  if (row.product_image) {
    const imagePreview = await previewProductImages(
      db,
      productData?.id ?? null,
      row.product_image,
    );
    if (imagePreview.imageWillBeImported) {
      productChanges.imageWillBeImported = imagePreview.imageWillBeImported;
    }
    if (imagePreview.imageImportSkipped) {
      productChanges.imageImportSkipped = true;
    }
  }

  return { productData, productWillBeCreated, productChanges };
}

/**
 * Result of product operations including image import status
 */
interface ProductOperationsResult {
  productData: ProductTopLevelOut;
  productWasCreated: boolean;
  imageImportError?: string;
}

/**
 * Execute product creation/update and related operations
 */
async function executeProductOperations(
  db: Database,
  row: InventoryCSVRow,
  manufacturer: string,
  actor: ActorContext,
  productTimestamps?: ProductTimestamps,
): Promise<ProductOperationsResult> {
  const { productData, productWasCreated } = await processProductForImport(
    db,
    row.product_name,
    manufacturer,
    row.upc,
    row.expected_qty,
    row.ingredient_name,
    row.ingredient,
    row.model,
    row.ndb_number,
    row.aliases,
    row.category,
    actor,
    productTimestamps,
    row.product_shortcode,
  );

  if (row.price != null) {
    await createOrUpdatePriceMapping(db, productData.id, {
      value: row.price,
      unit: "dollar",
    });
  }

  if (row.unit_mappings) {
    await createUnitMappingsFromString(db, productData.id, row.unit_mappings);
  }

  // Import product images if provided
  let imageImportError: string | undefined;
  if (row.product_image) {
    const imageResult = await importProductImages(
      db,
      productData.id,
      row.product_image,
      row.product_name,
    );
    if (!imageResult.success && imageResult.error) {
      imageImportError = imageResult.error;
    }
  }

  return { productData, productWasCreated, imageImportError };
}

// ============================================================================
// Location Resolution
// ============================================================================

interface LocationResolutionResult {
  targetLocationId: LocationId | null;
  locationNotFound: boolean;
}

/**
 * Find the target location for an inventory row by shortcode or name
 * Shortcode takes priority if provided, then falls back to name.
 * Locations must exist (created via Locations sheet)
 */
async function resolveTargetLocation(
  db: Database,
  locationName: string,
  locationShortcode: string | null | undefined,
): Promise<LocationResolutionResult> {
  // Try shortcode first if provided
  if (locationShortcode) {
    const idFromShortcode = await findLocationByShortcode(
      db,
      locationShortcode,
    );
    if (idFromShortcode) {
      return {
        targetLocationId: idFromShortcode,
        locationNotFound: false,
      };
    }
    // Shortcode provided but not found - fall through to name lookup
  }

  // Fall back to name lookup
  const targetLocationId = await findLocationByName(db, locationName);
  return {
    targetLocationId,
    locationNotFound: targetLocationId === null,
  };
}

// ============================================================================
// Move Detection
// ============================================================================

interface MoveCheckResult {
  shouldMove: boolean;
  existingLocations: string[];
  isOnlyAtTarget: boolean;
}

/**
 * Check if inventory should be moved (product exists elsewhere, not at target)
 *
 * Move detection: if product has exactly 1 inventory entry in the app
 * and it's NOT at the target location, this is a move scenario.
 */
async function checkMoveConditions(
  db: Database,
  productData: ProductTopLevelOut,
  inventoryExists: boolean,
): Promise<MoveCheckResult> {
  // Get all locations where this product has inventory
  const existingLocations = await getExistingInventoryLocations(
    db,
    productData.id,
  );

  // No existing inventory → nothing to move
  if (existingLocations.length === 0) {
    return { shouldMove: false, existingLocations: [], isOnlyAtTarget: false };
  }

  // Check if inventory is only at the target location already
  const isOnlyAtTarget = existingLocations.length === 1 && inventoryExists;

  if (isOnlyAtTarget) {
    // Already at target, no move needed
    return { shouldMove: false, existingLocations, isOnlyAtTarget: true };
  }

  // Product has exactly 1 inventory entry elsewhere → move it to target
  // This handles the common "changed location in sheet" scenario
  const shouldMove = existingLocations.length === 1 && !inventoryExists;

  return { shouldMove, existingLocations, isOnlyAtTarget };
}

// ============================================================================
// Result Building Helpers
// ============================================================================

interface BaseResultFields {
  rowIndex: number;
  productName: string;
  locationName?: string;
  locationId?: LocationId;
  productId?: ProductId;
  upc?: string;
}

/**
 * Build a dry-run result item with preview-specific fields
 */
function buildDryRunResult(
  base: BaseResultFields,
  action: CSVImportResultItem["action"],
  options: {
    productChanges: ProductChangesPreview;
    productWillBeCreated: boolean;
    locationNotFound?: boolean;
    inventoryFieldChanges?: FieldChange[];
    movedFrom?: string[];
    message?: string;
  },
): CSVImportResultItem {
  return {
    rowIndex: base.rowIndex,
    action,
    productName: base.productName,
    locationName: base.locationName,
    locationId: base.locationId,
    movedFrom: options.movedFrom,
    message: options.message,
    fieldChanges: buildFieldChanges(
      options.productChanges,
      options.inventoryFieldChanges,
    ),
    productWillBeCreated: options.productWillBeCreated,
    locationNotFound: options.locationNotFound,
    productChanges: wrapChanges(options.productChanges),
  };
}

/**
 * Build an execution result item (non-dry-run)
 */
function buildExecutionResult(
  base: BaseResultFields,
  action: CSVImportResultItem["action"],
  message?: string,
  movedFrom?: string[],
  imageImportError?: string,
): CSVImportResultItem {
  let finalMessage = message;
  if (imageImportError) {
    const imageWarning = `(image import failed: ${imageImportError})`;
    finalMessage = finalMessage
      ? `${finalMessage} ${imageWarning}`
      : imageWarning;
  }
  return {
    rowIndex: base.rowIndex,
    action,
    productName: base.productName,
    productId: base.productId,
    upc: base.upc,
    locationName: base.locationName,
    locationId: base.locationId,
    movedFrom,
    message: finalMessage,
  };
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
  const { db, dryRun, actor } = ctx;
  const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;
  const isProductOnly = !row.location_name || row.location_name.trim() === "";

  // Parse timestamps from row (if SYNC_TIMESTAMPS enabled)
  const timestamps = parseRowTimestamps(row);

  // -------------------------------------------------------------------------
  // Step 1: Process product (preview or execute)
  // -------------------------------------------------------------------------
  let productData: ProductTopLevelOut | null;
  let productWillBeCreated = false;
  let productChanges: ProductChangesPreview = {};
  let imageImportError: string | undefined;

  if (dryRun) {
    const result = await previewProduct(db, row, manufacturer);
    productData = result.productData;
    productWillBeCreated = result.productWillBeCreated;
    productChanges = result.productChanges;
  } else {
    const result = await executeProductOperations(
      db,
      row,
      manufacturer,
      actor,
      timestamps.product,
    );
    productData = result.productData;
    productWillBeCreated = result.productWasCreated;
    imageImportError = result.imageImportError;
  }

  // -------------------------------------------------------------------------
  // Step 2: Handle product-only rows (no inventory placement)
  // -------------------------------------------------------------------------
  if (isProductOnly) {
    return handleProductOnlyRow(
      row,
      rowIndex,
      productData,
      productWillBeCreated,
      productChanges,
      imageImportError,
    );
  }

  // After the isProductOnly check above, location_name is guaranteed to be defined
  // TypeScript doesn't understand this control flow, so we add a defensive check
  const locationName = row.location_name;
  if (!locationName) {
    throw new Error(
      "Unexpected: location_name should be defined after isProductOnly check",
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: Resolve target location
  // -------------------------------------------------------------------------
  const { targetLocationId, locationNotFound } = await resolveTargetLocation(
    db,
    locationName,
    row.location_shortcode,
  );

  const newAmount = { value: row.quantity, unit: row.unit };
  const base: BaseResultFields = {
    rowIndex,
    productName: row.product_name,
    locationName: row.location_name,
    locationId: targetLocationId ?? undefined,
    productId: productData?.id,
    upc: row.upc,
  };

  // -------------------------------------------------------------------------
  // Step 4: Handle new product creation (dry-run)
  // -------------------------------------------------------------------------
  if (dryRun && productWillBeCreated) {
    return buildDryRunResult(base, "created", {
      productChanges,
      productWillBeCreated: true,
      locationNotFound,
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Handle missing location - auto-create as root "room"
  // -------------------------------------------------------------------------
  let resolvedLocationId = targetLocationId;
  let locationWasCreated = false;

  if (!resolvedLocationId) {
    if (dryRun) {
      // In dry-run mode, we can't create the location, but we can indicate it will be created
      // For now, return a "created" action with locationNotFound flag
      return buildDryRunResult(base, "created", {
        productChanges,
        productWillBeCreated,
        locationNotFound: true,
        message: `Location "${locationName}" will be auto-created`,
      });
    }

    // Auto-create the location as a root with default type "room"
    const createResult = await findOrCreateLocationByName(
      db,
      locationName,
      null, // no parent
      "room", // default type for auto-created locations
    );
    resolvedLocationId = createResult.locationId;
    locationWasCreated = createResult.created;

    // Update base with the new location ID
    base.locationId = resolvedLocationId;
  }

  // At this point we must have productData and resolvedLocationId
  if (!productData) {
    throw new Error("Unexpected state: missing product data");
  }

  // -------------------------------------------------------------------------
  // Step 6: Check inventory state and move conditions
  // -------------------------------------------------------------------------
  const inventoryCheck = await checkInventoryMatch(
    db,
    productData.id,
    resolvedLocationId,
    newAmount,
  );

  const moveCheck = await checkMoveConditions(
    db,
    productData,
    inventoryCheck.exists,
  );

  // -------------------------------------------------------------------------
  // Step 7: Handle move case
  // -------------------------------------------------------------------------
  if (
    moveCheck.shouldMove &&
    !moveCheck.isOnlyAtTarget &&
    moveCheck.existingLocations.length > 0
  ) {
    return handleMoveCase(
      db,
      base,
      productData,
      resolvedLocationId,
      newAmount,
      moveCheck.existingLocations,
      productChanges,
      productWillBeCreated,
      dryRun,
      imageImportError,
      locationWasCreated,
      timestamps.inventory,
    );
  }

  // -------------------------------------------------------------------------
  // Step 8: Handle skip/update/create
  // -------------------------------------------------------------------------
  return handleInventoryResult(
    db,
    base,
    productData,
    resolvedLocationId,
    newAmount,
    inventoryCheck,
    productChanges,
    productWillBeCreated,
    dryRun,
    imageImportError,
    locationWasCreated,
    timestamps.inventory,
  );
};

// ============================================================================
// Row Processing Sub-handlers
// ============================================================================

/**
 * Handle product-only rows (no location_name)
 */
function handleProductOnlyRow(
  row: InventoryCSVRow,
  rowIndex: number,
  productData: ProductTopLevelOut | null,
  productWillBeCreated: boolean,
  productChanges: ProductChangesPreview,
  imageImportError?: string,
): CSVImportResultItem {
  const hasProductChanges_ = hasChanges(productChanges);
  // Skip if product exists with no changes (regardless of dryRun mode)
  const shouldSkip = !productWillBeCreated && !hasProductChanges_;
  const fieldChanges = buildFieldChanges(productChanges);

  let message = shouldSkip
    ? "Product already exists with no changes"
    : productWillBeCreated
      ? "New product"
      : undefined;

  // Append image import error if present
  if (imageImportError) {
    const imageWarning = `(image import failed: ${imageImportError})`;
    message = message ? `${message} ${imageWarning}` : imageWarning;
  }

  return {
    rowIndex,
    action: shouldSkip ? "skipped" : "product_only",
    productName: row.product_name,
    productId: productData?.id,
    upc: row.upc,
    locationName: undefined,
    message,
    fieldChanges,
    productWillBeCreated,
    productChanges: wrapChanges(productChanges),
  };
}

/**
 * Handle move case (both dry-run and execution)
 */
async function handleMoveCase(
  db: Database,
  base: BaseResultFields,
  productData: ProductTopLevelOut,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
  existingLocations: string[],
  productChanges: ProductChangesPreview,
  productWillBeCreated: boolean,
  dryRun: boolean,
  imageImportError?: string,
  locationWasCreated?: boolean,
  inventoryTimestamps?: InventoryTimestamps,
): Promise<CSVImportResultItem> {
  const locationNote = locationWasCreated ? " (location auto-created)" : "";

  if (dryRun) {
    return buildDryRunResult(base, "moved", {
      productChanges,
      productWillBeCreated,
      movedFrom: existingLocations,
      message: `Will move from ${existingLocations.join(", ")}${locationNote}`,
    });
  }

  const fromLocations = await moveInventoryEntries(
    db,
    productData.id,
    targetLocationId,
    newAmount,
    inventoryTimestamps,
  );

  if (fromLocations.length > 0) {
    return buildExecutionResult(
      base,
      "moved",
      `Moved from ${fromLocations.join(", ")}${locationNote}`,
      fromLocations,
      imageImportError,
    );
  }

  // Fallback - shouldn't happen but handle gracefully
  return buildExecutionResult(
    base,
    "created",
    locationNote || undefined,
    undefined,
    imageImportError,
  );
}

/**
 * Handle final inventory result (skip/update/create)
 */
async function handleInventoryResult(
  db: Database,
  base: BaseResultFields,
  productData: ProductTopLevelOut,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
  inventoryCheck: {
    exists: boolean;
    matches: boolean;
    currentAmount?: { value: number; unit: string };
  },
  productChanges: ProductChangesPreview,
  productWillBeCreated: boolean,
  dryRun: boolean,
  imageImportError?: string,
  locationWasCreated?: boolean,
  inventoryTimestamps?: InventoryTimestamps,
): Promise<CSVImportResultItem> {
  const locationNote = locationWasCreated ? " (location auto-created)" : "";

  if (dryRun) {
    if (inventoryCheck.matches) {
      const productFieldChanges = buildFieldChanges(productChanges);
      return buildDryRunResult(
        base,
        productFieldChanges ? "updated" : "skipped",
        {
          productChanges,
          productWillBeCreated,
          message: productFieldChanges
            ? undefined
            : "Already exists with same quantity",
        },
      );
    }

    if (inventoryCheck.exists) {
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

      return buildDryRunResult(base, "updated", {
        productChanges,
        productWillBeCreated,
        inventoryFieldChanges,
      });
    }

    return buildDryRunResult(base, "created", {
      productChanges,
      productWillBeCreated,
    });
  }

  // Execution mode
  if (inventoryCheck.matches) {
    return buildExecutionResult(
      base,
      "skipped",
      "Already exists with same quantity",
      undefined,
      imageImportError,
    );
  }

  const action = await createOrUpdateInventoryAtLocation(
    db,
    productData.id,
    targetLocationId,
    newAmount,
    inventoryTimestamps,
  );

  const message =
    action === "updated"
      ? `Updated existing entry quantity${locationNote}`
      : locationNote || undefined;

  return buildExecutionResult(
    base,
    action,
    message,
    undefined,
    imageImportError,
  );
}

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
  checkUnitMappingsChanges,
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
  organizationId: OrganizationId,
  row: InventoryCSVRow,
  manufacturer: string,
): Promise<ProductProcessingResult> {
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
      const mappings = await parseUnitMappingsForPreview(row.unit_mappings);
      productChanges.unitMappingsWillBeAdded = mappings.count;
      productChanges.unitMappingsDetail = mappings.details;
    }
  }

  return { productData, productWillBeCreated, productChanges };
}

/**
 * Execute product creation/update and related operations
 */
async function executeProductOperations(
  db: Database,
  organizationId: OrganizationId,
  row: InventoryCSVRow,
  manufacturer: string,
  actor: ActorContext,
): Promise<ProductTopLevelOut> {
  const productData = await findOrCreateProductForImport(
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

  if (row.price != null) {
    await createOrUpdatePriceMapping(db, productData.id, {
      value: row.price,
      unit: "dollar",
    });
  }

  if (row.unit_mappings) {
    await createUnitMappingsFromString(db, productData.id, row.unit_mappings);
  }

  return productData;
}

// ============================================================================
// Location Resolution
// ============================================================================

interface LocationResolutionResult {
  targetLocationId: LocationId | null;
  locationWillBeCreated: boolean;
}

/**
 * Find or create the target location for an inventory row
 */
async function resolveTargetLocation(
  db: Database,
  organizationId: OrganizationId,
  locationPath: string,
  locationTypeContext: LocationTypeContext,
  dryRun: boolean,
): Promise<LocationResolutionResult> {
  if (dryRun) {
    const targetLocationId = await findLocationByPath(
      db,
      organizationId,
      locationPath,
    );
    return {
      targetLocationId,
      locationWillBeCreated: targetLocationId === null,
    };
  }

  const targetLocationId = await findOrCreateLocationByPathWithContext(
    db,
    organizationId,
    locationPath,
    locationTypeContext,
  );
  return { targetLocationId, locationWillBeCreated: false };
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
 * Check if inventory should be moved (product at capacity, not already at target)
 */
async function checkMoveConditions(
  db: Database,
  organizationId: OrganizationId,
  productData: ProductTopLevelOut,
  targetLocationId: LocationId | null,
  inventoryExists: boolean,
): Promise<MoveCheckResult> {
  const totalExistingQty = await getTotalProductQuantity(
    db,
    productData.id,
    organizationId,
  );

  const shouldMove =
    productData.expectedQuantity !== null &&
    totalExistingQty >= productData.expectedQuantity;

  if (!shouldMove) {
    return { shouldMove: false, existingLocations: [], isOnlyAtTarget: false };
  }

  const existingLocations = await getExistingInventoryLocations(
    db,
    organizationId,
    productData.id,
  );

  const isOnlyAtTarget = existingLocations.length === 1 && inventoryExists;

  return { shouldMove, existingLocations, isOnlyAtTarget };
}

// ============================================================================
// Result Building Helpers
// ============================================================================

interface BaseResultFields {
  rowIndex: number;
  productName: string;
  locationPath?: string;
  locationId?: LocationId;
  productId?: string;
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
    locationWillBeCreated: boolean;
    inventoryFieldChanges?: FieldChange[];
    movedFrom?: string[];
    message?: string;
  },
): CSVImportResultItem {
  return {
    rowIndex: base.rowIndex,
    action,
    productName: base.productName,
    locationPath: base.locationPath,
    locationId: base.locationId,
    movedFrom: options.movedFrom,
    message: options.message,
    fieldChanges: buildFieldChanges(
      options.productChanges,
      options.inventoryFieldChanges,
    ),
    productWillBeCreated: options.productWillBeCreated,
    locationWillBeCreated: options.locationWillBeCreated,
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
): CSVImportResultItem {
  return {
    rowIndex: base.rowIndex,
    action,
    productName: base.productName,
    productId: base.productId,
    upc: base.upc,
    locationPath: base.locationPath,
    locationId: base.locationId,
    movedFrom,
    message,
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
  const { db, organizationId, locationTypeContext, dryRun, actor } = ctx;
  const manufacturer = row.manufacturer ?? UNSPECIFIED_MANUFACTURER;
  const isProductOnly = !row.location_path || row.location_path.trim() === "";

  // -------------------------------------------------------------------------
  // Step 1: Process product (preview or execute)
  // -------------------------------------------------------------------------
  let productData: ProductTopLevelOut | null;
  let productWillBeCreated = false;
  let productChanges: ProductChangesPreview = {};

  if (dryRun) {
    const result = await previewProduct(db, organizationId, row, manufacturer);
    productData = result.productData;
    productWillBeCreated = result.productWillBeCreated;
    productChanges = result.productChanges;
  } else {
    productData = await executeProductOperations(
      db,
      organizationId,
      row,
      manufacturer,
      actor,
    );
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
      dryRun,
    );
  }

  // After the isProductOnly check above, location_path is guaranteed to be defined
  // TypeScript doesn't understand this control flow, so we add a defensive check
  const locationPath = row.location_path;
  if (!locationPath) {
    throw new Error(
      "Unexpected: location_path should be defined after isProductOnly check",
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: Resolve target location
  // -------------------------------------------------------------------------
  const { targetLocationId, locationWillBeCreated } =
    await resolveTargetLocation(
      db,
      organizationId,
      locationPath,
      locationTypeContext,
      dryRun,
    );

  const newAmount = { value: row.quantity, unit: row.unit };
  const base: BaseResultFields = {
    rowIndex,
    productName: row.product_name,
    locationPath: row.location_path,
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
      locationWillBeCreated,
    });
  }

  // -------------------------------------------------------------------------
  // Step 5: Handle missing location (dry-run) - check for move
  // -------------------------------------------------------------------------
  if (dryRun && !targetLocationId) {
    return handleMissingLocationDryRun(
      db,
      organizationId,
      base,
      productData,
      productWillBeCreated,
      productChanges,
    );
  }

  // At this point we must have productData and targetLocationId
  if (!productData || !targetLocationId) {
    throw new Error("Unexpected state: missing product or location data");
  }

  // -------------------------------------------------------------------------
  // Step 6: Check inventory state and move conditions
  // -------------------------------------------------------------------------
  const inventoryCheck = await checkInventoryMatch(
    db,
    organizationId,
    productData.id,
    targetLocationId,
    newAmount,
  );

  const moveCheck = await checkMoveConditions(
    db,
    organizationId,
    productData,
    targetLocationId,
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
      organizationId,
      base,
      productData,
      targetLocationId,
      newAmount,
      moveCheck.existingLocations,
      productChanges,
      productWillBeCreated,
      locationWillBeCreated,
      dryRun,
    );
  }

  // -------------------------------------------------------------------------
  // Step 8: Handle skip/update/create
  // -------------------------------------------------------------------------
  return handleInventoryResult(
    db,
    organizationId,
    base,
    productData,
    targetLocationId,
    newAmount,
    inventoryCheck,
    productChanges,
    productWillBeCreated,
    locationWillBeCreated,
    dryRun,
  );
};

// ============================================================================
// Row Processing Sub-handlers
// ============================================================================

/**
 * Handle product-only rows (no location_path)
 */
function handleProductOnlyRow(
  row: InventoryCSVRow,
  rowIndex: number,
  productData: ProductTopLevelOut | null,
  productWillBeCreated: boolean,
  productChanges: ProductChangesPreview,
  dryRun: boolean,
): CSVImportResultItem {
  const hasProductChanges_ = hasChanges(productChanges);
  const shouldSkip = dryRun && !productWillBeCreated && !hasProductChanges_;
  const fieldChanges = buildFieldChanges(productChanges);

  const message = shouldSkip
    ? "Product already exists with no changes"
    : productWillBeCreated
      ? "New product"
      : fieldChanges
        ? undefined
        : dryRun
          ? "Product already exists"
          : undefined;

  return {
    rowIndex,
    action: shouldSkip ? "skipped" : "product_only",
    productName: row.product_name,
    productId: productData?.id,
    upc: row.upc,
    locationPath: undefined,
    message,
    fieldChanges,
    productWillBeCreated,
    productChanges: wrapChanges(productChanges),
  };
}

/**
 * Handle dry-run with no target location found
 */
async function handleMissingLocationDryRun(
  db: Database,
  organizationId: OrganizationId,
  base: BaseResultFields,
  productData: ProductTopLevelOut | null,
  productWillBeCreated: boolean,
  productChanges: ProductChangesPreview,
): Promise<CSVImportResultItem> {
  // Check if this should be a move
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
        return buildDryRunResult({ ...base, locationId: undefined }, "moved", {
          productChanges,
          productWillBeCreated,
          locationWillBeCreated: true,
          movedFrom: existingLocations,
          message: `Will move from ${existingLocations.join(", ")}`,
        });
      }
    }
  }

  // Not a move - it's a create with new location
  return buildDryRunResult({ ...base, locationId: undefined }, "created", {
    productChanges,
    productWillBeCreated,
    locationWillBeCreated: true,
  });
}

/**
 * Handle move case (both dry-run and execution)
 */
async function handleMoveCase(
  db: Database,
  organizationId: OrganizationId,
  base: BaseResultFields,
  productData: ProductTopLevelOut,
  targetLocationId: LocationId,
  newAmount: { value: number; unit: string },
  existingLocations: string[],
  productChanges: ProductChangesPreview,
  productWillBeCreated: boolean,
  locationWillBeCreated: boolean,
  dryRun: boolean,
): Promise<CSVImportResultItem> {
  if (dryRun) {
    return buildDryRunResult(base, "moved", {
      productChanges,
      productWillBeCreated,
      locationWillBeCreated,
      movedFrom: existingLocations,
      message: `Will move from ${existingLocations.join(", ")}`,
    });
  }

  const fromLocations = await moveInventoryEntries(
    db,
    organizationId,
    productData.id,
    targetLocationId,
    newAmount,
  );

  if (fromLocations.length > 0) {
    return buildExecutionResult(
      base,
      "moved",
      `Moved from ${fromLocations.join(", ")}`,
      fromLocations,
    );
  }

  // Fallback - shouldn't happen but handle gracefully
  return buildExecutionResult(base, "created");
}

/**
 * Handle final inventory result (skip/update/create)
 */
async function handleInventoryResult(
  db: Database,
  organizationId: OrganizationId,
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
  locationWillBeCreated: boolean,
  dryRun: boolean,
): Promise<CSVImportResultItem> {
  if (dryRun) {
    if (inventoryCheck.matches) {
      const productFieldChanges = buildFieldChanges(productChanges);
      return buildDryRunResult(
        base,
        productFieldChanges ? "updated" : "skipped",
        {
          productChanges,
          productWillBeCreated,
          locationWillBeCreated,
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
        locationWillBeCreated,
        inventoryFieldChanges,
      });
    }

    return buildDryRunResult(base, "created", {
      productChanges,
      productWillBeCreated,
      locationWillBeCreated,
    });
  }

  // Execution mode
  if (inventoryCheck.matches) {
    return buildExecutionResult(
      base,
      "skipped",
      "Already exists with same quantity",
    );
  }

  const action = await createOrUpdateInventoryAtLocation(
    db,
    organizationId,
    productData.id,
    targetLocationId,
    newAmount,
  );

  return buildExecutionResult(
    base,
    action,
    action === "updated" ? "Updated existing entry quantity" : undefined,
  );
}

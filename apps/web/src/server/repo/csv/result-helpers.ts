/**
 * Shared helpers for building CSV import/export results
 *
 * Used by both push (export to sheet) and pull (import from sheet) flows
 * to ensure consistent result structure and counting.
 */

import {
  type FieldChange,
  LOCATION_CSV_ACTIONS,
  type LocationCSVAction,
} from "~/schemas/csv";

// =============================================================================
// Generic Counter Types and Functions
// =============================================================================

/**
 * Generic counter type - keys are the action names
 */
type ResultCounters<TAction extends string> = Record<TAction, number>;

/**
 * Create counters initialized to zero for any action set
 */
function createCounters<TAction extends string>(
  actions: readonly TAction[],
): ResultCounters<TAction> {
  return Object.fromEntries(
    actions.map((a) => [a, 0]),
  ) as ResultCounters<TAction>;
}

/**
 * Increment the appropriate counter based on action type
 */
export function incrementCounter<TAction extends string>(
  counters: ResultCounters<TAction>,
  action: TAction,
): void {
  counters[action]++;
}

/**
 * Create counters for location CSV operations
 */
export function createLocationCounters(): ResultCounters<LocationCSVAction> {
  return createCounters(LOCATION_CSV_ACTIONS);
}

// =============================================================================
// Inventory-specific Result Helpers (for backward compatibility)
// =============================================================================

import { type LocationId, type ProductId } from "~/schemas/identifiers";
import {
  type CSVImportResult,
  type CSVImportResultItem,
} from "~/schemas/inventory";

/**
 * Legacy result counters interface for inventory
 * @deprecated Use createInventoryCounters() instead
 */
interface LegacyResultCounters {
  created: number;
  moved: number;
  updated: number;
  skipped: number;
  errors: number;
  productOnly: number;
  removed: number;
}

/**
 * Create a fresh set of counters initialized to zero (legacy format)
 * @deprecated Use createInventoryCounters() instead
 */
export function createResultCounters(): LegacyResultCounters {
  return {
    created: 0,
    moved: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    productOnly: 0,
    removed: 0,
  };
}

/**
 * Increment counter (legacy format)
 * Maps action names to counter property names
 */
export function incrementLegacyCounter(
  counters: LegacyResultCounters,
  action: CSVImportResultItem["action"],
): void {
  switch (action) {
    case "created":
      counters.created++;
      break;
    case "moved":
      counters.moved++;
      break;
    case "updated":
      counters.updated++;
      break;
    case "skipped":
      counters.skipped++;
      break;
    case "error":
      counters.errors++;
      break;
    case "product_only":
      counters.productOnly++;
      break;
    case "removed":
      counters.removed++;
      break;
  }
}

/**
 * Build a CSVImportResult from counters and items (legacy format)
 */
export function buildImportResult(
  counters: LegacyResultCounters,
  items: CSVImportResultItem[],
): CSVImportResult {
  return {
    created: counters.created,
    moved: counters.moved,
    updated: counters.updated,
    skipped: counters.skipped,
    errors: counters.errors,
    productOnly: counters.productOnly,
    removed: counters.removed > 0 ? counters.removed : undefined,
    items,
  };
}

/**
 * Common fields for building result items
 */
interface ResultItemBase {
  rowIndex: number;
  productName: string;
  productId?: ProductId;
  locationName?: string;
  locationId?: LocationId;
  message?: string;
  fieldChanges?: FieldChange[];
}

/**
 * Build a result item and increment the counter
 */
function pushResultItem(
  items: CSVImportResultItem[],
  counters: LegacyResultCounters,
  action: CSVImportResultItem["action"],
  base: ResultItemBase,
): void {
  items.push({
    rowIndex: base.rowIndex,
    action,
    productName: base.productName,
    productId: base.productId,
    locationName: base.locationName,
    locationId: base.locationId,
    message: base.message,
    fieldChanges: base.fieldChanges,
  });
  incrementLegacyCounter(counters, action);
}

/**
 * Build an error result item
 */
export function pushErrorItem(
  items: CSVImportResultItem[],
  counters: LegacyResultCounters,
  rowIndex: number,
  productName: string,
  message: string,
  locationName?: string,
): void {
  pushResultItem(items, counters, "error", {
    rowIndex,
    productName,
    locationName,
    message,
  });
}

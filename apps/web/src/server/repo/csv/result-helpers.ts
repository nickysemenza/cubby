/**
 * Shared helpers for building CSV import/export results
 *
 * Used by both push (export to sheet) and pull (import from sheet) flows
 * to ensure consistent result structure and counting.
 */

import {
  type FieldChange,
  INVENTORY_CSV_ACTIONS,
  type InventoryCSVAction,
} from "@cubby/schemas/csv";
import type { LocationId, ProductId } from "@cubby/schemas/identifiers";
import type {
  CSVImportResult,
  CSVImportResultItem,
} from "@cubby/schemas/inventory";

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

/** Type alias for inventory counters */
export type InventoryCounters = ResultCounters<InventoryCSVAction>;

/**
 * Create counters for inventory CSV operations
 */
export function createInventoryCounters(): InventoryCounters {
  return createCounters(INVENTORY_CSV_ACTIONS);
}

/**
 * Build a CSVImportResult from counters and items
 * Transforms action names to result schema keys (e.g., "error" → "errors")
 */
export function buildInventoryResult(
  counters: InventoryCounters,
  items: CSVImportResultItem[],
): CSVImportResult {
  return {
    created: counters.created,
    moved: counters.moved,
    updated: counters.updated,
    skipped: counters.skipped,
    errors: counters.error, // action "error" → result key "errors"
    productOnly: counters.product_only, // action "product_only" → result key "productOnly"
    removed: counters.removed > 0 ? counters.removed : undefined,
    renamed: counters.renamed > 0 ? counters.renamed : undefined,
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
  counters: InventoryCounters,
  action: InventoryCSVAction,
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
  incrementCounter(counters, action);
}

/**
 * Build an error result item
 */
export function pushErrorItem(
  items: CSVImportResultItem[],
  counters: InventoryCounters,
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

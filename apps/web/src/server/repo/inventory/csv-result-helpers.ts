/**
 * Shared helpers for building CSV import/export results
 *
 * Used by both push (export to sheet) and pull (import from sheet) flows
 * to ensure consistent result structure and counting.
 */

import {
  type CSVImportResult,
  type CSVImportResultItem,
  type FieldChange,
} from "~/schemas/inventory";
import { type LocationId, type ProductId } from "~/schemas/identifiers";

/**
 * Mutable counters for tracking import/export results
 */
export interface ResultCounters {
  created: number;
  moved: number;
  updated: number;
  skipped: number;
  errors: number;
  productOnly: number;
  removed: number;
}

/**
 * Create a fresh set of counters initialized to zero
 */
export function createResultCounters(): ResultCounters {
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
 * Increment the appropriate counter based on action type
 */
export function incrementCounter(
  counters: ResultCounters,
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
 * Build a CSVImportResult from counters and items
 */
export function buildImportResult(
  counters: ResultCounters,
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
export function pushResultItem(
  items: CSVImportResultItem[],
  counters: ResultCounters,
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
  incrementCounter(counters, action);
}

/**
 * Build an error result item
 */
export function pushErrorItem(
  items: CSVImportResultItem[],
  counters: ResultCounters,
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

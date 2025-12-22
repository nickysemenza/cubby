/**
 * Generic CSV comparison framework
 *
 * Provides a configurable comparison function builder that can be used
 * by any entity (inventory, location, etc.) for push/pull sync operations.
 */

import { type FieldChange } from "~/schemas/csv";
import {
  type ResultCounters,
  createCounters,
  incrementCounter,
  buildResult,
} from "./result-helpers";
import { normalizeForComparison } from "./normalize";

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Configuration for building a comparison function
 *
 * @template TAppRow - The type of rows from the app (export format)
 * @template TSheetRow - The type of rows from the sheet/CSV (import format)
 * @template TResultItem - The type of result items to produce
 * @template TAction - The action type enum (e.g., 'created' | 'updated' | ...)
 */
export interface ComparisonConfig<
  TAppRow,
  TSheetRow,
  TResultItem,
  TAction extends string,
> {
  /**
   * Action set for this entity (used for counter initialization)
   */
  actions: readonly TAction[];

  /**
   * Generate lookup key from a sheet row
   * Key should be normalized for case-insensitive comparison
   */
  getSheetKey: (row: TSheetRow) => string;

  /**
   * Generate lookup key from an app row
   * Must use same format as getSheetKey for matching
   */
  getAppKey: (row: TAppRow) => string;

  /**
   * Optional: Custom matching logic for complex cases
   * If not provided, uses simple key equality
   *
   * For example, inventory uses this for fuzzy manufacturer matching
   * where multiple sheet rows may have the same product+location key
   *
   * @param appRow - The app row to find a match for
   * @param candidates - Sheet rows with matching keys
   * @param matchedIndices - Set of already-matched sheet row indices
   * @param allSheetRows - All sheet rows (for index lookup)
   * @returns The matching sheet row and its index, or undefined
   */
  findMatch?: (
    appRow: TAppRow,
    candidates: TSheetRow[],
    matchedIndices: Set<number>,
    allSheetRows: TSheetRow[],
  ) => { row: TSheetRow; index: number } | undefined;

  /**
   * Compare an app row with a sheet row and return field differences
   */
  getDifferences: (appRow: TAppRow, sheetRow: TSheetRow) => FieldChange[];

  /**
   * Build a result item for a newly created row (exists in app, not in sheet)
   */
  buildCreatedItem: (rowIndex: number, appRow: TAppRow) => TResultItem;

  /**
   * Build a result item for an updated row (exists in both, has differences)
   */
  buildUpdatedItem: (
    rowIndex: number,
    appRow: TAppRow,
    fieldChanges: FieldChange[],
  ) => TResultItem;

  /**
   * Build a result item for a skipped row (exists in both, no differences)
   */
  buildSkippedItem: (rowIndex: number, appRow: TAppRow) => TResultItem;

  /**
   * Build a result item for a removed row (exists in sheet, not in app)
   */
  buildRemovedItem: (sheetRow: TSheetRow) => TResultItem;

  /**
   * The action string for each result type
   * Allows mapping to entity-specific action names
   */
  createdAction: TAction;
  updatedAction: TAction;
  skippedAction: TAction;
  removedAction: TAction;
}

/**
 * Result type from comparison function
 */
export type ComparisonResult<TResultItem, TAction extends string> = {
  items: TResultItem[];
} & ResultCounters<TAction>;

// =============================================================================
// Comparison Function Builder
// =============================================================================

/**
 * Create a comparison function for push preview
 *
 * Compares app rows against sheet rows to determine what changes
 * would be made when pushing to the sheet:
 * - created: exists in app but not in sheet
 * - updated: exists in both but has differences
 * - skipped: exists in both with no differences
 * - removed: exists in sheet but not in app
 *
 * @example
 * ```ts
 * const compareLocationsForPush = createComparisonFunction({
 *   actions: LOCATION_CSV_ACTIONS,
 *   getSheetKey: (row) => normalizeForComparison(row.location_name),
 *   getAppKey: (row) => normalizeForComparison(row.location_name),
 *   getDifferences: getLocationRowDifferences,
 *   buildCreatedItem: (idx, row) => ({ rowIndex: idx, action: 'created', ... }),
 *   // ... other builders
 * });
 * ```
 */
export function createComparisonFunction<
  TAppRow,
  TSheetRow,
  TResultItem,
  TAction extends string,
>(
  config: ComparisonConfig<TAppRow, TSheetRow, TResultItem, TAction>,
): (
  appRows: TAppRow[],
  sheetRows: TSheetRow[],
) => ComparisonResult<TResultItem, TAction> {
  return (appRows, sheetRows) => {
    const items: TResultItem[] = [];
    const counters = createCounters(config.actions);

    // Build a map of sheet rows by key
    // Each key may have multiple rows (for entities with compound keys)
    const sheetByKey = new Map<string, TSheetRow[]>();
    for (const row of sheetRows) {
      const key = config.getSheetKey(row);
      const existing = sheetByKey.get(key) ?? [];
      existing.push(row);
      sheetByKey.set(key, existing);
    }

    // Track which sheet rows we've matched (by index in original array)
    const matchedSheetIndices = new Set<number>();

    // Compare app rows against sheet
    for (let i = 0; i < appRows.length; i++) {
      const appRow = appRows[i];
      const key = config.getAppKey(appRow);

      // Find candidates with same key
      const candidates = sheetByKey.get(key) ?? [];

      // Find a matching row
      let matchedSheetRow: TSheetRow | undefined;
      let matchedSheetIndex = -1;

      if (config.findMatch) {
        // Use custom matching logic
        const match = config.findMatch(
          appRow,
          candidates,
          matchedSheetIndices,
          sheetRows,
        );
        if (match) {
          matchedSheetRow = match.row;
          matchedSheetIndex = match.index;
        }
      } else {
        // Simple matching: use first unmatched candidate
        for (const candidate of candidates) {
          const sheetIndex = sheetRows.indexOf(candidate);
          if (!matchedSheetIndices.has(sheetIndex)) {
            matchedSheetRow = candidate;
            matchedSheetIndex = sheetIndex;
            break;
          }
        }
      }

      if (!matchedSheetRow) {
        // New row - doesn't exist in sheet
        items.push(config.buildCreatedItem(i, appRow));
        incrementCounter(counters, config.createdAction);
      } else {
        // Mark this sheet row as matched
        matchedSheetIndices.add(matchedSheetIndex);

        // Row exists - check if different
        const fieldChanges = config.getDifferences(appRow, matchedSheetRow);

        if (fieldChanges.length > 0) {
          items.push(config.buildUpdatedItem(i, appRow, fieldChanges));
          incrementCounter(counters, config.updatedAction);
        } else {
          items.push(config.buildSkippedItem(i, appRow));
          incrementCounter(counters, config.skippedAction);
        }
      }
    }

    // Find rows in sheet that weren't matched (will be removed)
    for (let i = 0; i < sheetRows.length; i++) {
      if (!matchedSheetIndices.has(i)) {
        items.push(config.buildRemovedItem(sheetRows[i]));
        incrementCounter(counters, config.removedAction);
      }
    }

    return buildResult(counters, items);
  };
}

// =============================================================================
// Utility Exports
// =============================================================================

export { normalizeForComparison };

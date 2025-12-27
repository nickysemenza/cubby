/**
 * Generic field comparison and update utilities for CSV/sync operations
 *
 * Reduces repetitive if-statement patterns by using declarative field specs.
 */

import type { FieldChange } from "~/schemas/csv";

// =============================================================================
// Types
// =============================================================================

/** Normalizer function to transform values before comparison */
export type NormalizeFn = (val: unknown) => unknown;

/** Field spec for row comparisons (e.g., getRowDifferences) */
export type ComparisonFieldSpec<TApp, TSheet> = {
  /** Display name for FieldChange */
  field: string;
  /** Key in app row */
  appKey: keyof TApp;
  /** Key in sheet row */
  sheetKey: keyof TSheet;
  /** Optional normalizer (default: nullToEmpty) */
  normalize?: NormalizeFn;
};

// =============================================================================
// Normalizers
// =============================================================================

/** Normalize null/undefined to empty string (used as default in compareFields) */
const nullToEmpty = (v: unknown): string => (v as string) ?? "";

/** Pass through null, normalize undefined to null */
export const nullToNull = (v: unknown): unknown => v ?? null;

// =============================================================================
// Generic Comparison
// =============================================================================

/**
 * Compare fields between app and sheet rows using field specs
 *
 * @param specs - Field specifications defining how to compare each field
 * @param appRow - Row from the app (source of truth for "to" values)
 * @param sheetRow - Row from the sheet (source of truth for "from" values)
 * @returns Array of field changes where values differ
 */
export const compareFields = <TApp, TSheet>(
  specs: readonly ComparisonFieldSpec<TApp, TSheet>[],
  appRow: TApp,
  sheetRow: TSheet,
): FieldChange[] => {
  const changes: FieldChange[] = [];

  for (const spec of specs) {
    const normalize = spec.normalize ?? nullToEmpty;
    const appVal = normalize(appRow[spec.appKey]);
    const sheetVal = normalize(sheetRow[spec.sheetKey]);

    if (appVal !== sheetVal) {
      changes.push({
        field: spec.field,
        from: (sheetRow[spec.sheetKey] as unknown) ?? null,
        to: (appRow[spec.appKey] as unknown) ?? null,
      });
    }
  }

  return changes;
};

// =============================================================================
// Audit Helpers
// =============================================================================

/**
 * Build audit changes from before state and updates
 *
 * @param beforeState - State before updates
 * @param updates - The updates being applied
 * @returns Record of field changes with from/to values
 */
export const buildAuditChanges = <T extends Record<string, unknown>>(
  beforeState: T,
  updates: Partial<T>,
): Record<string, { from: unknown; to: unknown }> => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  for (const key of Object.keys(updates) as (keyof T)[]) {
    const from = beforeState[key];
    const to = updates[key];
    if (from !== to) {
      changes[key as string] = { from, to };
    }
  }

  return changes;
};

/**
 * Merge updates into an existing object (immutably)
 *
 * @param existing - Existing object
 * @param updates - Updates to merge
 * @returns New object with updates applied
 */
export const applyUpdates = <T extends Record<string, unknown>>(
  existing: T,
  updates: Partial<T>,
): T => ({ ...existing, ...updates });

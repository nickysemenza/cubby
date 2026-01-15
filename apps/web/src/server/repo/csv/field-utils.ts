/**
 * Generic field comparison and update utilities for CSV/sync operations
 *
 * Reduces repetitive if-statement patterns by using declarative field specs.
 */

import type { FieldChange } from "~/schemas/csv";

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

/** Normalize null/undefined to empty string (used as default in compareFields) */
const nullToEmpty = (v: unknown): string => (v as string) ?? "";

/** Pass through null, normalize undefined to null */
export const nullToNull = (v: unknown): unknown => v ?? null;

/**
 * Compare fields between app and sheet rows using field specs.
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

/**
 * Build audit changes from before state and updates.
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
 * Merge updates into an existing object (immutably).
 */
export const applyUpdates = <T extends Record<string, unknown>>(
  existing: T,
  updates: Partial<T>,
): T => ({ ...existing, ...updates });

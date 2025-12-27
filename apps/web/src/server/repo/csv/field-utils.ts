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

/** Normalize null/undefined to empty string */
export const nullToEmpty = (v: unknown): string => (v as string) ?? "";

/** Pass through null, normalize undefined to null */
export const nullToNull = (v: unknown): unknown => v ?? null;

/** Create a normalizer that defaults to a specific value */
export const defaultTo =
  <T>(defaultVal: T) =>
  (v: unknown): T =>
    (v as T) ?? defaultVal;

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
// Update Building (for product/entity updates)
// =============================================================================

/** Predicate to determine if a field should be updated */
export type ShouldUpdateFn<TCurrent, TNext> = (
  current: TCurrent,
  next: TNext,
) => boolean;

/** Field spec for building update objects */
export type UpdateFieldSpec<TKey extends string, TCurrent, TNext> = {
  /** Key in the update object and existing entity */
  key: TKey;
  /** Key in the input data (defaults to same as key) */
  inputKey?: string;
  /** Predicate to determine if this field should be updated */
  shouldUpdate: ShouldUpdateFn<TCurrent, TNext>;
};

/**
 * Build an updates object from field specs
 *
 * @param specs - Field specifications with update predicates
 * @param existing - Existing entity values
 * @param input - Input values from CSV/form
 * @returns Partial update object with only changed fields
 */
export const buildUpdates = <
  TKey extends string,
  TExisting extends Record<TKey, unknown>,
  TInput extends Record<string, unknown>,
>(
  specs: readonly UpdateFieldSpec<TKey, unknown, unknown>[],
  existing: TExisting,
  input: TInput,
): Partial<Record<TKey, unknown>> => {
  const updates: Partial<Record<TKey, unknown>> = {};

  for (const spec of specs) {
    const inputKey = spec.inputKey ?? spec.key;
    const current = existing[spec.key];
    const next = input[inputKey];

    if (spec.shouldUpdate(current, next)) {
      updates[spec.key] = next;
    }
  }

  return updates;
};

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

/**
 * Shared CSV import/export infrastructure
 *
 * This module provides common utilities for CSV handling across entities:
 * - Result helpers: counters, builders for tracking import/export results
 * - Comparison framework: generic push/pull diff generation
 * - Normalization utilities: string normalization for comparison
 */

// Result helpers
export {
  type ResultCounters,
  createCounters,
  incrementCounter,
  buildResult,
  createInventoryCounters,
  createLocationCounters,
  // Legacy exports for backward compatibility
  type LegacyResultCounters,
  createResultCounters,
  incrementLegacyCounter,
  buildImportResult,
  pushResultItem,
  pushErrorItem,
} from "./result-helpers";

// Comparison framework
export {
  type ComparisonConfig,
  type ComparisonResult,
  createComparisonFunction,
} from "./comparison";

// Normalization utilities
export {
  normalizeForComparison,
  normalizeManufacturer,
  manufacturersMatch,
} from "./normalize";

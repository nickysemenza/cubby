/**
 * Shared CSV import/export schema types
 *
 * These types are used by both inventory and location CSV handling
 * to ensure consistent patterns across entities.
 */

import { z } from "zod";

// =============================================================================
// Shared Field Change Type
// =============================================================================

/**
 * Represents a single field change for displaying diffs
 * Used by both inventory and location comparison/sync
 */
export const fieldChange = z.object({
  field: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});

export type FieldChange = z.infer<typeof fieldChange>;

// =============================================================================
// Action Types
// =============================================================================

/**
 * Base actions all CSV-enabled entities share
 */
const BASE_CSV_ACTIONS = [
  "created",
  "updated",
  "skipped",
  "error",
  "removed",
] as const;

type BaseCSVAction = (typeof BASE_CSV_ACTIONS)[number];

/**
 * Location uses base actions only
 */
export const LOCATION_CSV_ACTIONS = BASE_CSV_ACTIONS;

export type LocationCSVAction = BaseCSVAction;

/**
 * Inventory adds "moved", "product_only", and "renamed" actions
 */
export const INVENTORY_CSV_ACTIONS = [
  ...BASE_CSV_ACTIONS,
  "moved",
  "product_only",
  "renamed",
] as const;

export type InventoryCSVAction = (typeof INVENTORY_CSV_ACTIONS)[number];

// =============================================================================
// Base CSV Result Schemas
// =============================================================================

/**
 * Base fields for CSV result items (shared by inventory and location)
 */
export const baseCsvResultItem = z.object({
  rowIndex: z.number(),
  message: z.string().optional(),
  fieldChanges: z.array(fieldChange).optional(),
});

/**
 * Base count fields for CSV import results (shared by inventory and location)
 */
export const baseCsvImportCounts = z.object({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
  errors: z.number(),
  removed: z.number().optional(),
});

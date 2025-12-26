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

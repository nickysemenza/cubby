/**
 * Sync configuration flags
 *
 * These control optional sync behaviors that can be toggled for development/production.
 */

/**
 * When true, includes timestamp columns (created_at, updated_at) in CSV export/import.
 * This preserves entity timestamps through Sheets sync cycles.
 *
 * Set to false to disable timestamp columns (e.g., when you have proper dev/prod separation).
 */
export const SYNC_TIMESTAMPS = true;

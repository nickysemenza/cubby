import type { LocationId } from "~/schemas/identifiers";
import type { LocationType } from "~/schemas/location";

/**
 * Location row for CSV export
 * Contains all fields needed for round-trip import/export
 */
export interface LocationCSVExportRow {
  location_name: string; // Unique location name
  parent_name: string | null; // Parent location name (null for root)
  location_type: LocationType;
  description: string | null;
  location_image: string | null; // Semicolon-separated image URLs
  last_inventory_date: string | null; // ISO timestamp of when location was last inventoried
  // Internal ID (not exported to sheet, used for comparison)
  location_id: LocationId;
  // Timestamps (optional, controlled by SYNC_TIMESTAMPS flag)
  location_created_at?: string | null;
  location_updated_at?: string | null;
}

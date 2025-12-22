/**
 * Location CSV export
 */

import { type Database } from "~/server/db";
import {
  type OrganizationId,
  locationId as locationIdSchema,
} from "~/schemas/identifiers";
import { getDb } from "~/server/repo/database-helpers";
import { location } from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { type LocationCSVExportRow } from "./types";
import { type LocationType } from "~/schemas/location";
import { joinImageUrls } from "~/lib/image-utils";

/**
 * Query all locations with their images and immediate parent
 */
async function getLocationsWithParent(
  db: Database,
  organizationId: OrganizationId,
) {
  return getDb(db).query.location.findMany({
    where: eq(location.organizationId, organizationId),
    with: {
      images: {
        with: { image: true },
      },
      parent: true,
    },
  });
}

/**
 * Export all locations to CSV format
 *
 * Returns one row per location with:
 * - location_name: unique location name
 * - parent_name: parent location name (null for root)
 * - location_type: the location's type (room, shelf, drawer, etc.)
 * - description: optional description
 * - location_image: semicolon-separated image URLs
 * - location_id: internal ID for comparison
 */
export const exportLocationsToCSV = async (
  db: Database,
  organizationId: OrganizationId,
): Promise<LocationCSVExportRow[]> => {
  const locations = await getLocationsWithParent(db, organizationId);

  return locations.map((loc) => ({
    location_name: loc.name,
    parent_name: loc.parent?.name ?? null,
    location_type: loc.type as LocationType,
    description: null, // Location doesn't have a description field currently
    location_image: joinImageUrls(loc.images),
    location_id: locationIdSchema.parse(loc.id),
  }));
};

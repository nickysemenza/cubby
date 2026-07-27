/**
 * Location-centric Problems detectors.
 * Empty leaf locations (no inventory, no children), image-bearing locations
 * that still lack an AI description, and stocked locations overdue for a
 * recount.
 */

import type {
  EmptyLocation,
  LocationWithoutAiDescription,
  StaleLocation,
} from "@cubby/schemas/problems";
import { and, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location, locationImage } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

// EmptyLocation is re-exported from the package barrel for the Problems-page
// components that import it from there.
export type { EmptyLocation };

// Find leaf locations with no inventory entries (excludes parent locations)
export const findEmptyLocations = async (
  db: Database,
): Promise<EmptyLocation[]> => {
  const dbClient = getDb(db);

  // Alias for checking child locations
  const childLocation = dbClient
    .$with("child_location")
    .as(
      dbClient
        .select({ parentId: location.parentId })
        .from(location)
        .where(notDeleted(location)),
    );

  const emptyLocations = await dbClient
    .with(childLocation)
    .select({
      id: location.id,
      name: location.name,
      type: location.type,
      createdAt: location.createdAt,
      lastBulkInventory: location.lastBulkInventory,
      aiDescription: location.aiDescription,
      firstImageUrl: sql<string | null>`(
        SELECT "Image"."url" FROM "LocationImage"
        JOIN "Image" ON "Image"."id" = "LocationImage"."imageId"
        WHERE "LocationImage"."locationId" = "Location"."id"
        ORDER BY "LocationImage"."createdAt" ASC
        LIMIT 1
      )`,
      firstImageId: sql<string | null>`(
        SELECT "Image"."id" FROM "LocationImage"
        JOIN "Image" ON "Image"."id" = "LocationImage"."imageId"
        WHERE "LocationImage"."locationId" = "Location"."id"
        ORDER BY "LocationImage"."createdAt" ASC
        LIMIT 1
      )`,
    })
    .from(location)
    .where(
      and(
        notDeleted(location),
        // No inventory entries
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(inventoryEntry)
            .where(
              and(
                eq(inventoryEntry.locationId, location.id),
                notDeleted(inventoryEntry),
              ),
            ),
        ),
        // No child locations (is a leaf node)
        notExists(
          dbClient
            .select({ id: sql`1` })
            .from(childLocation)
            .where(eq(childLocation.parentId, location.id)),
        ),
      ),
    );

  return emptyLocations;
};

/**
 * How long a stocked bin may go without a deliberate recount before its counts
 * are treated as unverified. Deliberately looser than AuditedHint's 30-day
 * visual tint: the hint nudges, this raises a Problems row. (Tenet 1 — nothing
 * else restores inventory truth, so an uncounted bin just drifts.)
 */
const STALE_RECOUNT_DAYS = 60;

/**
 * Locations holding stock whose last recount is missing or older than
 * STALE_RECOUNT_DAYS. Empty locations are out of scope — they have no counts to
 * be wrong, and `findEmptyLocations` already covers them.
 */
export const findStaleLocations = async (
  db: Database,
): Promise<StaleLocation[]> => {
  const dbClient = getDb(db);
  const cutoff = new Date(Date.now() - STALE_RECOUNT_DAYS * 86_400_000);

  const rows = await dbClient
    .select({
      id: location.id,
      name: location.name,
      type: location.type,
      lastBulkInventory: location.lastBulkInventory,
      itemCount: sql<number>`count(${inventoryEntry.id})::int`,
    })
    .from(location)
    // INNER join = "non-empty" (locations with no live entry drop out).
    .innerJoin(
      inventoryEntry,
      and(
        eq(inventoryEntry.locationId, location.id),
        notDeleted(inventoryEntry),
      ),
    )
    .where(
      and(
        notDeleted(location),
        or(
          isNull(location.lastBulkInventory),
          lt(location.lastBulkInventory, cutoff),
        ),
      ),
    )
    .groupBy(
      location.id,
      location.name,
      location.type,
      location.lastBulkInventory,
    )
    // Never-recounted first, then oldest — the worst offenders lead the card.
    .orderBy(sql`${location.lastBulkInventory} asc nulls first`);

  return rows.map((r) => ({ ...r, itemCount: Number(r.itemCount) }));
};

// Find locations that have images but no AI description
export const findLocationsWithoutAiDescription = async (
  db: Database,
): Promise<LocationWithoutAiDescription[]> => {
  const dbClient = getDb(db);

  const results = await dbClient
    .select({
      id: location.id,
      name: location.name,
      type: location.type,
      imageCount: sql<number>`count(${locationImage.id})`,
    })
    .from(location)
    .innerJoin(locationImage, eq(locationImage.locationId, location.id))
    .where(and(notDeleted(location), isNull(location.aiDescription)))
    .groupBy(location.id, location.name, location.type);

  return results.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    imageCount: Number(r.imageCount),
  }));
};

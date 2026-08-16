/**
 * Location-centric Problems detectors.
 *
 * Only recount staleness lives here now. Empty leaves and the missing-AI-
 * description backlog became saved views (`location/empty-leaves`,
 * `location/undescribed`) — both were plain column predicates the location list
 * could already express, and routing them through it also dropped a pair of
 * hand-written correlated image subqueries.
 *
 * This one stays because its cutoff is relative to now, which a static view
 * declaration can't carry.
 */

import { unsafeLocationShortcode } from "@cubby/schemas/identifiers";
import type { EmptyLocation, StaleLocation } from "@cubby/schemas/problems";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { inventoryEntry, location } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { stockOnly } from "~/server/repo/inventory/placement";

// EmptyLocation is re-exported from the package barrel for the Problems-page
// components that import it from there.
export type { EmptyLocation };

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
      shortcode: location.shortcode,
      name: location.name,
      type: location.type,
      lastBulkInventory: location.lastBulkInventory,
      itemCount: sql<number>`count(${inventoryEntry.id})::int`,
    })
    .from(location)
    // INNER join = "non-empty" (locations with no live entry drop out).
    // stockOnly() must match findEmptyLocations's notExists, or a
    // fixture-only location gets flagged as both empty AND stale.
    .innerJoin(
      inventoryEntry,
      and(
        eq(inventoryEntry.locationId, location.id),
        notDeleted(inventoryEntry),
        stockOnly(),
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
      location.shortcode,
      location.name,
      location.type,
      location.lastBulkInventory,
    )
    // Never-recounted first, then oldest — the worst offenders lead the card.
    .orderBy(sql`${location.lastBulkInventory} asc nulls first`);

  return rows.map((r) => ({
    ...r,
    id: unsafeLocationShortcode(r.shortcode),
    itemCount: Number(r.itemCount),
  }));
};

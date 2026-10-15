/** Reads a location's current AI description; the SQL lives in `db/computed/location-ai-description`. */
import type { LocationId } from "@cubby/schemas/identifiers";
import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { locationAiDescriptionSql } from "~/server/db/computed/location-ai-description";
import { getDb } from "~/server/db/helpers";
import { location } from "~/server/db/schema";

/**
 * The description a location shows right now (null when none was ever analyzed).
 *
 * The id goes in as a bound value, never `location.id`: drizzle prints a single-table select's
 * columns unqualified, so `location.id` inside the correlated subquery would read the analysis
 * row's own `id` and the description would always come back null.
 */
export const readLocationAiDescription = async (
  db: Database,
  locationId: LocationId,
): Promise<string | null> => {
  const [row] = await getDb(db)
    .select({ description: locationAiDescriptionSql(sql`${locationId}`) })
    .from(location)
    .where(eq(location.id, locationId));
  return row?.description ?? null;
};

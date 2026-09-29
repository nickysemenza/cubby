/**
 * A location's AI description, read from the latest live `location-description`
 * AiAnalysis. The Location row stores nothing: the analysis IS the description,
 * so a re-run, a new prompt version or a retired analysis changes what every
 * surface shows without a second write to keep in step.
 *
 * Kept as literal SQL over the analysis table (no typed foreign-table columns):
 * the relational-query layer rewrites an embedded typed `Column` to the
 * primary table's alias, which breaks a correlated subquery over another table.
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

import { location } from "~/server/db/schema";

/** The analysis feature id `describeLocation` writes under. */
export const LOCATION_DESCRIPTION_FEATURE_ID = "location-description";

/** Scalar subquery: the description text for `locationId`'s row, or NULL. */
export const locationAiDescriptionSql = (
  locationId: AnyColumn | SQL,
): SQL<string | null> => sql<string | null>`(
  SELECT a."result"->>'description' FROM "AiAnalysis" a
  WHERE a."entityKind" = 'location' AND a."entityId" = ${locationId}
    AND a."feature" = ${LOCATION_DESCRIPTION_FEATURE_ID} AND a."deletedAt" IS NULL
  ORDER BY a."updatedAt" DESC, a."id" DESC
  LIMIT 1
)`;

/**
 * `extras` for a `db.query.location.*` config: exposes the computed description
 * as the row's `aiDescription`, where the mappers have always read it.
 */
export const locationAiDescriptionExtras = {
  aiDescription: locationAiDescriptionSql(location.id).as("aiDescription"),
};

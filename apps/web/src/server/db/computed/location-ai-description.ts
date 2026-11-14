/** A location description is its manual Decision or the Answer its fields scope used. */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { relationalSql } from "~/server/db/helpers/relational-sql";
import { location } from "~/server/db/retained-tables";

/** The analysis feature id `describeLocation` writes under. */
const LOCATION_DESCRIPTION_FEATURE_ID = "location-description";

/** Scalar subquery: the description text for `locationId`'s row, or NULL. */
export const locationAiDescriptionSql = (
  locationId: AnyColumn | SQL,
): SQL<string | null> => sql<string | null>`(CASE WHEN EXISTS (
  SELECT 1 FROM (SELECT d.kind FROM "Decision" d WHERE d.subject=${"location-description/"} || ${locationId}::text
    AND d.channel=${"assignment"} AND d.slot=${"text"} ORDER BY d.at DESC, d.id DESC LIMIT 1) manual
  WHERE manual.kind <> ${"release"}) THEN (
  SELECT d.value #>> '{}' FROM "Decision" d WHERE d.subject=${"location-description/"} || ${locationId}::text
    AND d.channel=${"assignment"} AND d.slot=${"text"} ORDER BY d.at DESC, d.id DESC LIMIT 1)
  ELSE (SELECT coalesce(a.output->'value'->>'description', a.output->>'description')
  FROM "ScopeState" state
  CROSS JOIN LATERAL jsonb_array_elements(state.inputs) used
  JOIN "Answer" a ON a."inputHash" = used->>'inputHash'
  WHERE state."scopeKind" = ${"fields"} AND state."scopeKey" = ${"location:"} || ${locationId}::text
    AND a.feature = ${LOCATION_DESCRIPTION_FEATURE_ID}
  ORDER BY a."createdAt" DESC LIMIT 1) END)`;

/**
 * `extras` for a `db.query.location.*` config: exposes the computed description
 * as the row's `aiDescription`, where the mappers have always read it.
 */
export const locationAiDescriptionExtras = {
  aiDescription: (table: PgTable) =>
    relationalSql(
      table,
      locationAiDescriptionSql(location.id).as("aiDescription"),
    ),
};

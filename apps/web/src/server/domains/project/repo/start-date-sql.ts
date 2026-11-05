import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/** Reuse the canonical hourly date fold; a member's explicit override reads immediately. */
export const projectStartDateRowsSql = (): SQL => sql`
  SELECT p.id AS "entityId",
    coalesce(p."startDate", (s.rollups #>> '{dateWindow,derivedStart}')::date) AS value,
    CASE WHEN p."startDate" IS NOT NULL THEN now() AT TIME ZONE 'UTC'
      ELSE s."rollupsComputedAt" END AS "computedAt"
  FROM "Project" p LEFT JOIN "ProjectReadSnapshot" s ON s."entityId" = p.id
  WHERE ${notDeleted("p")}`;

import { sql } from "drizzle-orm";

/** Original source identities retain their canonical Product even after editable links disappear. */
export const originalProductReferencesSql = sql`(
  SELECT coalesce(identity."mergedIntoId", identity.id) AS "productId"
  FROM (
    SELECT original."productId" FROM "ImportSourceProduct" original
    UNION ALL
    SELECT (binding->>'productId')::uuid AS "productId"
    FROM "SourceOrderObservation" observation
    CROSS JOIN LATERAL jsonb_array_elements(observation."productBindings") binding
    WHERE binding->>'productId' IS NOT NULL
  ) original
  JOIN "Entity" identity ON identity.id = original."productId"
)`;

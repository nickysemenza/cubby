import type { EmbeddableEntity } from "@cubby/schemas/entity-manifest";
import { entityManifest } from "@cubby/schemas/entity-manifest";
import type { RelatedRecordSignal } from "@cubby/schemas/related-record-signals";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

const overlapRow = z.object({
  entityId: z.string(),
  values: z.array(z.string()),
});
export type ScalarOverlapRow = z.infer<typeof overlapRow>;

/** Expand only a declared stored text field. Caps suppress ubiquitous tag hubs. */
export async function readScalarOverlaps(
  db: Database,
  entity: EmbeddableEntity,
  sourceId: string,
  signal: Extract<RelatedRecordSignal, { kind: "scalarOverlap" }>,
): Promise<ScalarOverlapRow[]> {
  const table = entityManifest[entity].dbTable;
  if (!table)
    throw new Error(`Relatedness requires a stored entity: ${entity}`);
  const result = await repositoryQueries(db).execute(
    sql`
    WITH source_values AS (
      SELECT DISTINCT value FROM ${sql.identifier(table)} source
      CROSS JOIN LATERAL jsonb_array_elements_text(to_jsonb(source.${sql.identifier(signal.field)})) value
      WHERE source.id = ${sourceId}::uuid AND ${notDeleted("source")}
    ), candidate_overlaps AS (
      SELECT candidate.id AS "entityId", value
      FROM ${sql.identifier(table)} candidate
      CROSS JOIN LATERAL jsonb_array_elements_text(to_jsonb(candidate.${sql.identifier(signal.field)})) value
      JOIN source_values USING (value)
      WHERE candidate.id <> ${sourceId}::uuid AND ${notDeleted("candidate")}
      GROUP BY candidate.id, value
    ), eligible AS (
      SELECT value FROM candidate_overlaps GROUP BY value HAVING count(*) <= ${signal.popularityCap}
    )
    SELECT "entityId", array_agg(value ORDER BY value) AS values
    FROM candidate_overlaps JOIN eligible USING (value)
    GROUP BY "entityId" ORDER BY "entityId"
  `,
    "objects",
  );
  return result.map((row) => overlapRow.parse(row));
}

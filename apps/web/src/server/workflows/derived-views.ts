import { storedFieldDecision } from "@cubby/schemas/derived-value";
import { entitySchema } from "@cubby/schemas/entity";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { entityStoredDerivedDeclarations } from "~/server/db/derived-declarations";
import { notDeleted } from "~/server/db/helpers/predicates";
import { productCostViewSql } from "~/server/domains/product/repo/cost-sql";
import { projectStartDateRowsSql } from "~/server/domains/project/repo/start-date-sql";

/** View adapters use the same canonical SQL as domain reads; ownership stays on the manifest. */
const viewQueries = new Map<string, SQL>([
  ["product.cost", productCostViewSql],
  [
    "project.startDate",
    sql`SELECT "Project".id AS "entityId", ${entitySchema.enum.project}::text AS kind,
    to_jsonb(d.value::text) AS value, d.value::timestamp AS "sortDate", NULL::double precision AS "sortNumber", NULL::text AS "sortText",
    jsonb_build_object('outcome', CASE WHEN d.value IS NULL THEN '{"kind":"empty","reason":"unset"}'::jsonb ELSE '{"kind":"value"}'::jsonb END,
      ${storedFieldDecision.keyof().enum.provenance}::text, CASE WHEN "Project"."startDate" IS NULL THEN '{"kind":"computed"}'::jsonb ELSE '{"kind":"own","ownership":{"kind":"record"}}'::jsonb END) AS "decidedBy",
    d."computedAt" AS "computedAt"
    FROM "Project" JOIN "Entity" identity ON identity.id = "Project".id AND identity.kind = ${entitySchema.enum.project}
    JOIN (${projectStartDateRowsSql()}) d ON d."entityId" = "Project".id
    WHERE ${notDeleted("Project")} AND ${notDeleted("identity")}`,
  ],
]);

/** Used only by migration generation and the scratch catalog model. */
export function renderDeclaredDerivedViews(): string {
  return entityStoredDerivedDeclarations()
    .filter((entry) => entry.snapshotSource?.view)
    .map((entry) => {
      const query = viewQueries.get(entry.compute);
      if (!query || !entry.snapshotSource)
        throw new Error(`Missing declared view SQL: ${entry.target}`);
      return (
        new PgDialect().sqlToQuery(
          sql`CREATE OR REPLACE VIEW ${sql.identifier(entry.snapshotSource.table)} AS ${query}`.inlineParams(),
        ).sql + ";"
      );
    })
    .join("\n");
}

import type { SweepFamilyScope } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";

/** Selection reads observations without creating labels or booking from a label page. */
export async function statementSweepScopes(
  db: Database,
  scope: Extract<
    SweepFamilyScope,
    { family: "statement_transaction" }
  >["scope"],
) {
  const result = await repositoryQueries(db).execute<{ key: string }>(sql`
    SELECT o.id::text AS key FROM "SourceOccurrence" o
    JOIN "SourceTransactionRecord" observation ON observation.id=o."currentObservationId"
    WHERE ${notDeleted("o")} AND ${notDeleted("observation")}
      ${scope.accountIds ? sql`AND o."accountId" IN (SELECT jsonb_array_elements_text(${JSON.stringify(scope.accountIds)}::jsonb)::uuid)` : sql``}
      ${scope.since ? sql`AND observation."statementDate">=${scope.since}::date` : sql``}
      ${scope.importId ? sql`AND EXISTS (SELECT 1 FROM "TransactionImportRecord" received JOIN "SourceTransactionRecord" source ON source.id=received."statementRowId" WHERE ${notDeleted("source")} AND source."occurrenceId"=o.id AND received."importId"=${scope.importId}::uuid)` : sql``}
    ORDER BY o.id`);
  return result.rows.map(({ key }) => ({ kind: "bankEvent", key }));
}

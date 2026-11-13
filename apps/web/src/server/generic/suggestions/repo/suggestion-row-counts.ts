import { suggestionStatus } from "@cubby/schemas/ai";
import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import { textArrayParam } from "~/server/db/helpers/array-param";
import { requested } from "~/server/db/helpers/requested";
import { suggestionTable } from "~/server/db/schema";
import { suggestionStateAdmission } from "~/server/generic/suggestions/repo/suggestion-touching";

/** Count current decision gaps and the retained money-family review proposals. */
export async function loadSuggestionRowCounts(
  db: Database | DrizzleTransaction,
  entity: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const records = requested(ids.map((id) => ({ entity, id })));
  const rows = await unwrapDb(db)
    .select({
      recordId: suggestionTable.recordId,
      count: sql<number>`count(*)::int`,
    })
    .from(suggestionTable)
    .where(
      and(
        records.match({
          entity: sql`${suggestionTable.entity}`,
          id: sql`${suggestionTable.recordId}`,
        }),
        suggestionStateAdmission(
          database,
          {
            kind: "suggestions",
            families: [
              "statement_transaction",
              "transfer_pair",
              "product_pair",
            ],
            status: suggestionStatus.enum.pending,
          },
          {
            family: sql`${suggestionTable.family}`,
            status: sql`${suggestionTable.status}`,
            active: sql`${suggestionTable.active}`,
            runId: sql`${suggestionTable.runId}`,
          },
        ),
      ),
    )
    .groupBy(suggestionTable.recordId);
  for (const row of rows) if (row.recordId) counts.set(row.recordId, row.count);
  const kernel = await unwrapDb(db).execute<{
    recordId: string;
    count: number;
  }>(sql`
    WITH gaps AS (
      SELECT split_part(s."scopeKey", ':', 1) AS entity, split_part(s."scopeKey", ':', 2) AS "recordId", s."scopeKey" || ':' || coalesce(gap->${"actions"}->0->>${"field"}, gap::text) AS key
      FROM "ScopeState" s, jsonb_array_elements(s.gaps) gap WHERE s."scopeKind"=${"fields"} AND gap->>${"kind"}=${"decision"}
      UNION ALL
      SELECT endpoints.entity, endpoints.id::text, s."scopeKey" FROM "ScopeState" s
      JOIN LATERAL (SELECT e.* FROM "ConnectionCandidateEvidence" e WHERE e."scopeKey"=s."scopeKey" ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1) e ON true
      CROSS JOIN LATERAL (VALUES (e."sourceEntity",e."sourceId"),(e."targetEntity",e."targetId")) endpoints(entity,id)
      WHERE s."scopeKind"=${"connections"} AND jsonb_array_length(s.gaps)>0
    ) SELECT "recordId", count(DISTINCT key)::int AS count FROM gaps WHERE entity=${entity} AND "recordId"=ANY(${textArrayParam(ids)}) GROUP BY "recordId"`);
  for (const row of kernel.rows)
    counts.set(row.recordId, (counts.get(row.recordId) ?? 0) + row.count);
  return counts;
}

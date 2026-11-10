import { suggestionStatus } from "@cubby/schemas/ai";
import { suggestionFamily } from "@cubby/schemas/suggestion";
import { suggestionListFilters } from "@cubby/schemas/suggestion-list";
import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import { suggestionTable } from "~/server/db/schema";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { isReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import { suggestionStateAdmission } from "~/server/generic/suggestions/repo/suggestion-touching";

/** Count pending review publications on their primary record, excluding field guesses. */
export async function loadSuggestionRowCounts(
  db: Database | DrizzleTransaction,
  entity: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ids.length) return counts;
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const records = requested(ids.map((id) => ({ entity, id })));
  const rows = await unwrapDb(db)
    .select({
      recordId: suggestionTable.recordId,
      ids: sql<string[]>`array_agg(${suggestionTable.id})`,
      fieldIds: sql<
        string[]
      >`coalesce(array_agg(${suggestionTable.id}) filter (where ${suggestionTable.family} = ${suggestionFamily.enum.field}), '{}'::uuid[])`,
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
            families: Object.keys(suggestionFamilies)
              .map((family) => suggestionFamily.parse(family))
              .filter(isReviewFamily),
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
  const fieldIds = rows.flatMap((row) => row.fieldIds);
  // A disposition filter keeps guesses in the keys, so one pass labels them.
  const filters = {
    ...suggestionListFilters.parse({}),
    disposition: ["guess"],
  };
  const keys = fieldIds.length
    ? await suggestionFamilies.field.keys(database, {
        filters,
        suggestionIds: fieldIds,
      })
    : [];
  const excluded = new Set(
    keys
      .filter((key) => key.columns.disposition === "guess")
      .map((key) => key.suggestionId),
  );
  for (const row of rows)
    if (row.recordId)
      counts.set(
        row.recordId,
        row.ids.filter((id) => !excluded.has(id)).length,
      );
  return counts;
}

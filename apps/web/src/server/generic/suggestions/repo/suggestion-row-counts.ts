import { suggestionFamily } from "@cubby/schemas/suggestion";
import { suggestionListFilters } from "@cubby/schemas/suggestion-list";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import { requested } from "~/server/db/helpers/requested";
import { suggestionTable } from "~/server/db/schema";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";

/** Count pending review publications on their primary record, excluding field guesses. */
export async function loadSuggestionRowCounts(
  db: Database | DrizzleTransaction,
  entity: string,
  ids: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ids.length) return counts;
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
        eq(suggestionTable.status, "pending"),
        eq(suggestionTable.active, true),
        inArray(
          suggestionTable.family,
          Object.keys(suggestionFamilies).map((family) =>
            suggestionFamily.parse(family),
          ),
        ),
      ),
    )
    .groupBy(suggestionTable.recordId);
  const fieldIds = rows.flatMap((row) => row.fieldIds);
  const filters = suggestionListFilters.parse({});
  const familyDb = isTransaction(db) ? databaseForTransaction(db) : db;
  const [listed, guesses] = fieldIds.length
    ? await Promise.all([
        suggestionFamilies.field.keys(familyDb, {
          filters,
          suggestionIds: fieldIds,
        }),
        suggestionFamilies.field.keys(familyDb, {
          filters: { ...filters, disposition: ["guess"] },
          suggestionIds: fieldIds,
        }),
      ])
    : [[], []];
  const listedIds = new Set(listed.map((key) => key.suggestionId));
  const excluded = new Set(
    guesses.map((key) => key.suggestionId).filter((id) => !listedIds.has(id)),
  );
  for (const row of rows)
    if (row.recordId)
      counts.set(
        row.recordId,
        row.ids.filter((id) => !excluded.has(id)).length,
      );
  return counts;
}

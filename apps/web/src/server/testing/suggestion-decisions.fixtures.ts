import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { storedDecisions } from "~/server/generic/suggestions/repo/suggestion-decisions";

/** The decisions retained on one Suggestion, or on every Suggestion. */
export async function readSuggestionDecisions(
  db: Database,
  suggestionId?: string,
) {
  const rows = await getDb(db)
    .select({ id: suggestionTable.id, decisions: suggestionTable.decisions })
    .from(suggestionTable)
    .where(suggestionId ? eq(suggestionTable.id, suggestionId) : undefined);
  return rows.flatMap((row) => storedDecisions(row.id, row.decisions));
}

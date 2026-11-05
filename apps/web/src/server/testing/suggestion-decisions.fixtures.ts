import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import { storedDecisions } from "~/server/generic/assessment/repo/suggestion-decisions";

/** The decisions retained on one Suggestion, or on every Suggestion. */
export async function readSuggestionDecisions(
  db: Database,
  assessmentId?: string,
) {
  const rows = await getDb(db)
    .select({ id: suggestionTable.id, decisions: suggestionTable.decisions })
    .from(suggestionTable)
    .where(assessmentId ? eq(suggestionTable.id, assessmentId) : undefined);
  return rows.flatMap((row) => storedDecisions(row.id, row.decisions));
}

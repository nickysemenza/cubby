import { suggestionStatus } from "@cubby/schemas/ai";
import type { SuggestionListFamily } from "@cubby/schemas/suggestion-list";
import { sql } from "drizzle-orm";

import { unwrapDb } from "~/server/db/helpers";
import type { SuggestionFamilyPresentation } from "~/server/generic/suggestions/repo/suggestion-presentation";

export const outcomes =
  (
    family: SuggestionListFamily,
  ): SuggestionFamilyPresentation<typeof family>["outcomes"] =>
  async (db, filters) => {
    const { rows } = await unwrapDb(db).execute<{
      status: string;
      count: number;
    }>(sql`SELECT s.status, count(*)::int AS count FROM "Suggestion" s WHERE s.family = ${family}
    ${filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${filters.runId})` : sql``} GROUP BY s.status`);
    const count = (status: string) =>
      rows.find((row) => row.status === status)?.count ?? 0;
    return {
      applied: count(suggestionStatus.enum.applied),
      rejected: count(suggestionStatus.enum.rejected),
      resolved: count("resolved"),
      superseded: count(suggestionStatus.enum.superseded),
      fields: [],
    };
  };

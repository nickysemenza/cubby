import { suggestionStatus } from "@cubby/schemas/ai";
import { suggestionJudgments } from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { currentProductPairPolicySql } from "~/server/domains/product/repo/match/product-match-candidate";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  suggestionIdScope,
  type SuggestionFamilyQuery,
  type SuggestionKey,
} from "~/server/generic/suggestions/repo/suggestion-presentation";

export const actions = (
  ...verbs: (
    | "accept"
    | "correct"
    | "reject"
    | "dismiss"
    | "never_suggest"
    | "review_merge"
  )[]
) => verbs.map((verb) => ({ verb, ownerOnly: false }));
export { outcomes } from "~/server/generic/suggestions/repo/suggestion-outcomes";

export async function storedKeys(
  db: Database,
  query: SuggestionFamilyQuery,
  family: "product_pair",
): Promise<SuggestionKey[]> {
  if (query.filters.status !== "pending") return [];
  const declaration = reviewFamilyDeclarations[family];
  const rows = await unwrapDb(db).execute<{
    id: string;
    fingerprint: string | null;
    createdAt: Date | string;
    conflict: boolean;
  }>(
    sql`
    SELECT s.id, s.fingerprint, s."createdAt", COALESCE((s.judgment->>${suggestionJudgments.product_pair.keyof().enum.conflict})::boolean, false) AS conflict
    FROM "Suggestion" s
    WHERE s.family = ${family} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND s.suppression IS NULL AND ${declaration.actionable}
      AND ${suggestionIdScope(query.suggestionIds, sql`s.id`)}
      ${query.filters.runId ? sql`AND s."runId" = (SELECT id FROM "Run" WHERE shortcode = ${query.filters.runId})` : sql``}
      ${
        family === "product_pair"
          ? sql`AND ${currentProductPairPolicySql(sql`s.producer`)} AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id = s."recordId" AND ${notDeleted("p")})
        AND EXISTS (SELECT 1 FROM "Product" p WHERE p.id::text = s.data->>'otherId' AND ${notDeleted("p")})`
          : sql``
      }`,
    "objects",
  );
  return rows.map((row) => ({
    family,
    suggestionId: row.id,
    status: "pending",
    fingerprint: row.fingerprint,
    clean: false,
    strength: row.conflict ? "weak" : "medium",
    impact: [],
    createdAt: new Date(row.createdAt),
    columns: { entityKind: family === "product_pair" ? "product" : "image" },
    matchedRules: [],
    automaticRule: null,
  }));
}

import { suggestionStatus } from "@cubby/schemas/ai";
import {
  suggestionFamily,
  type SuggestionFamily,
} from "@cubby/schemas/suggestion";
import { and, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";

import { uuidArrayParam } from "~/server/db/helpers";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  reviewSuggestion,
  reviewState,
  entities,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";

export { pendingRecommendationEligibility } from "~/server/generic/suggestions/repo/pending-admission";

/** Rule applications leave pending and name the rule that applied them. */
export function automaticSuggestionEligibility(appliedRule: SQL) {
  return and(
    inArray(
      reviewSuggestion.family,
      Object.keys(reviewFamilyDeclarations).map((family) =>
        suggestionFamily.parse(family),
      ),
    ),
    ne(reviewState.status, suggestionStatus.enum.pending),
    isNotNull(appliedRule),
  );
}

export const suggestionRecordsSql = (
  entities?: readonly string[],
  familyColumn: SQL = sql`s.family`,
) =>
  sql`CASE ${sql.join(
    Object.entries(reviewFamilyDeclarations).map(
      ([family, spec]) =>
        sql`WHEN ${familyColumn} = ${family} THEN ${spec.affectedRecords.forward(entities)}`,
    ),
    sql` `,
  )} ELSE '[]'::jsonb END`;

/** The Work reason key suffix for an explicit correction that was never applied. */
export const UNAPPLIED_CORRECTION_REASON = "unapplied_correction";

/**
 * Record tokens per pending suggestion for Work. The large families read only
 * Suggestion columns; small families use their declared records. Tokens are UUIDs
 * or shortcodes, as stored. Current evidence is rechecked when a row is opened.
 */
export function pendingSuggestionRecordsSql(ids?: readonly string[]) {
  const pending = (families: readonly SuggestionFamily[]) =>
    sql`s.family IN (${sql.join(
      families.map((family) => sql`${family}`),
      sql`, `,
    )}) AND s.active AND s.status = ${suggestionStatus.enum.pending}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}`;
  const { recommendation, statement_transaction } = suggestionFamily.enum;
  return sql`SELECT s.family, s.entity, s."recordId"::text AS token
      FROM "Suggestion" s WHERE ${pending([recommendation])}
    UNION ALL
    SELECT s.family, s.data #>> '{connectionTarget,entityKind}', s.data #>> '{connectionTarget,entityId}'
      FROM "Suggestion" s
      WHERE ${pending([recommendation])} AND jsonb_typeof(s.data->'connectionTarget') = 'object'
    -- Statement review belongs to the account, not every settlement reference.
    UNION ALL
    SELECT s.family, ${entities.financialAccount}::text, s.data->>'accountId'
      FROM "Suggestion" s WHERE ${pending([statement_transaction])}
    -- An explicit correction its Suggestion never applied stays a manual notice.
    UNION ALL
    SELECT ${UNAPPLIED_CORRECTION_REASON}::text, s.entity, s."recordId"::text
      FROM "Suggestion" s
      WHERE s.status = ${suggestionStatus.enum.superseded}
        AND s.decisions @> ${JSON.stringify([{ authority: "member", correction: { present: true } }])}::jsonb
        ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}
    UNION ALL
    SELECT s.family, record->>'entity', record->>'id'
      FROM "Suggestion" s
      CROSS JOIN LATERAL jsonb_array_elements(${suggestionRecordsSql(undefined, sql`s.family`)}) record
      WHERE ${pending([
        suggestionFamily.enum.field,
        suggestionFamily.enum.transfer_pair,
        suggestionFamily.enum.product_pair,
        suggestionFamily.enum.image_description,
      ])} AND (s.family NOT IN (${suggestionFamily.enum.product_pair}, ${suggestionFamily.enum.image_description}) OR s.suppression IS NULL)`;
}

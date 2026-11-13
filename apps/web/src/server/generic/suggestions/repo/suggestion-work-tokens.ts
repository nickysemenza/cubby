import { suggestionStatus } from "@cubby/schemas/ai";
import {
  suggestionFamily,
  type SuggestionFamily,
} from "@cubby/schemas/suggestion";
import { and, isNotNull, ne, sql, type SQL } from "drizzle-orm";

import { columnArrayParam, uuidArrayParam } from "~/server/db/helpers/query";
import { suggestionFamilies as reviewFamilyDeclarations } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/suggestion-record-discovery";

/** Rule applications leave pending and name the rule that applied them. */
export function automaticSuggestionEligibility(appliedRule: SQL) {
  return and(
    sql`${reviewSuggestion.family} = ANY(${columnArrayParam(Object.keys(reviewFamilyDeclarations).map((family) => suggestionFamily.parse(family)))})`,
    ne(reviewSuggestion.status, suggestionStatus.enum.pending),
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
export function pendingSuggestionRecordsSql(
  ids?: readonly string[],
  /** Reason suffixes the read admits; branches outside it are not planned. */
  admitted?: ReadonlySet<string>,
) {
  const admits = (key: string) => !admitted || admitted.has(key);
  const pending = (families: readonly SuggestionFamily[]) =>
    sql`s.family = ANY(${columnArrayParam(families)}) AND s.active AND s.status = ${suggestionStatus.enum.pending}
      ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}`;
  const { recommendation } = suggestionFamily.enum;
  const declared = [
    suggestionFamily.enum.transfer_pair,
    suggestionFamily.enum.product_pair,
  ].filter(admits);
  const branches = [
    ...(admits("field")
      ? [
          sql`SELECT ${"field"}::text AS family, split_part(s."scopeKey", ':', 1) AS entity, split_part(s."scopeKey", ':', 2) AS token
      FROM "ScopeState" s WHERE s."scopeKind"='fields' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(s.gaps) gap, jsonb_array_elements(gap->'actions') action WHERE gap->>${"actor"}=${"you"} AND action ? ${"field"})
      ${ids ? sql`AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.inputs) used JOIN "Ask" k ON k."inputHash"=used->>'inputHash' WHERE k.id=ANY(${uuidArrayParam(ids)}))` : sql``}`,
        ]
      : []),
    ...(admits(recommendation)
      ? [
          sql`SELECT ${"recommendation"}::text AS family, endpoints.entity, endpoints.token FROM "ScopeState" s
      JOIN LATERAL (SELECT e.* FROM "ConnectionCandidateEvidence" e WHERE e."scopeKey"=s."scopeKey" ORDER BY e."createdAt" DESC, e.id DESC LIMIT 1) e ON true
      CROSS JOIN LATERAL (VALUES (e."sourceEntity",e."sourceId"::text),(e."targetEntity",e."targetId"::text)) endpoints(entity,token)
      WHERE s."scopeKind"=${"connections"} AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.gaps) gap WHERE gap->>${"actor"}=${"you"})`,
        ]
      : []),
    // An explicit correction its Suggestion never applied stays a manual notice.
    // The non-empty test matches Suggestion_member_decision_idx.
    ...(admits(UNAPPLIED_CORRECTION_REASON)
      ? [
          sql`SELECT ${UNAPPLIED_CORRECTION_REASON}::text AS family, s.entity, s."recordId"::text AS token
      FROM "Suggestion" s
      WHERE s.family NOT IN (${"field"}, ${"recommendation"}) AND s.status = ${suggestionStatus.enum.superseded}
        AND s.decisions <> '[]'::jsonb
        AND s.decisions @> ${JSON.stringify([{ authority: "member", correction: { present: true } }])}::jsonb
        ${ids ? sql`AND s.id = ANY(${uuidArrayParam(ids)})` : sql``}`,
        ]
      : []),
    ...(declared.length
      ? [
          sql`SELECT s.family, record->>'entity' AS entity, record->>'id' AS token
      FROM "Suggestion" s
      CROSS JOIN LATERAL jsonb_array_elements(${suggestionRecordsSql(undefined, sql`s.family`)}) record
      WHERE ${pending(declared)} AND (s.family <> ${suggestionFamily.enum.product_pair} OR s.suppression IS NULL)`,
        ]
      : []),
  ];
  return branches.length
    ? sql.join(branches, sql` UNION ALL `)
    : sql`SELECT NULL::text AS family, NULL::text AS entity, NULL::text AS token WHERE false`;
}

import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record";
import {
  statementTransactionAction,
  statementSuggestionOut,
} from "@cubby/schemas/statement-suggestion";
import { type SQL, sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sqlEnumConstant } from "~/server/db/sql-enum";

/**
 * Every live settlement reference with its transaction's shortcode — the
 * `(source, externalId)` pairs a statement row matches on.
 *
 * Joined once and hashed rather than probed per row: cost scales with the
 * references (~6k) rather than with SourceTransactionRecord (~34k).
 *
 * LOAD-BEARING: joining without DISTINCT is safe because the live
 * `EntityExternalId_source_kind_externalId_key` unique allows one live owner
 * per `(source, 'settlement_ref', externalId)`. The transaction must be live
 * too: its references are soft-deleted with it, and the join says so again.
 */
export const LIVE_REFS = sql`(
  SELECT fx."source" AS source, fx."externalId" AS "externalId", ft.shortcode
  FROM "EntityExternalId" fx
  JOIN "FinancialTransaction" ft ON ft."id" = fx."entityId" AND ${notDeleted("ft")}
  WHERE fx."kind" = 'settlement_ref' AND ${notDeleted("fx")}
)`;

/**
 * Explicit source-record identity. Historical reference strings remain links;
 * equal descriptions and amounts alone do not establish charge equivalence.
 */
export const chargeKeyOf = (alias: string) => sql.raw(`${alias}."chargeKey"`);

const statementReadFields = statementSuggestionOut.keyof();

/** Indexed current associations complement a publication's retained read set. */
export function statementSourceAssessmentIdsSql(
  kind:
    | "sourceTransactionRecord"
    | "financialTransaction"
    | "financialAccount"
    | "ledgerParty",
  refs: SQL,
): SQL {
  const pending = sql`s.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}`;
  if (kind === "sourceTransactionRecord")
    return sql`WITH changed_statement_sources AS MATERIALIZED (${refs})
      SELECT s.id FROM "SourceTransactionRecord" r
      JOIN "AssessmentState" s ON s.data->>${sqlEnumConstant(statementReadFields, statementReadFields.enum.source)} = r.source
        AND s.data->>${sqlEnumConstant(statementReadFields, statementReadFields.enum.chargeKey)} = ${chargeKeyOf("r")}
      WHERE r.id IN (SELECT id FROM changed_statement_sources) AND ${pending}`;
  if (kind === "financialAccount" || kind === "ledgerParty") {
    const accounts =
      kind === "financialAccount"
        ? refs
        : sql`SELECT account.id FROM "FinancialAccount" account
          WHERE account."ledgerPartyId" IN (${refs})`;
    return sql`SELECT s.id FROM (${accounts}) account
      JOIN "AssessmentState" s ON s.data->>'accountId' = account.id::text
      WHERE ${pending}`;
  }
  // Include removed evidence: deleting a settlement reference must refresh the
  // same retained advice as inserting it. Identity narrowing precedes JSON.
  return sql`WITH changed_settlement_keys AS MATERIALIZED (
      SELECT evidence.source, evidence."externalId" FROM "EntityExternalId" evidence
      WHERE evidence."entityId" IN (${refs}) AND evidence.kind = 'settlement_ref'
    ) SELECT s.id FROM changed_settlement_keys key
      JOIN "AssessmentState" s ON s.data->'refs' @> jsonb_build_array(key.source || ':' || key."externalId")
      WHERE ${pending}
    UNION SELECT s.id FROM changed_settlement_keys key
      CROSS JOIN LATERAL (
        SELECT a.id FROM "Assessment" a WHERE a.served
          AND a.judgment #>> '{create,sourceRef,source}' IS NOT NULL
          AND a.judgment #>> '{create,sourceRef,externalId}' IS NOT NULL
          AND md5(a.judgment #>> '{create,sourceRef,source}') = md5(key.source)
          AND md5(a.judgment #>> '{create,sourceRef,externalId}') = md5(key."externalId")
          AND a.judgment #>> '{create,sourceRef,source}' = key.source
          AND a.judgment #>> '{create,sourceRef,externalId}' = key."externalId"
        OFFSET 0
      ) a JOIN "AssessmentState" s ON s.id = a.id WHERE ${pending}`;
}

/**
 * Charge-level state over ALL live observations of a source, never a filtered
 * subset: a decision recorded on one observation (an ignore, a supersession,
 * a matched ref — including a ref equal to the charge's v1 hash) settles every
 * other observation of the same charge.
 */
export const chargeStateOf = (scope: SQL) => sql`(
  SELECT r.source, ${chargeKeyOf("r")} AS "chargeKey",
    bool_or(r.disposition = ${sourceTransactionRecordDisposition.enum.ignored}) AS ignored,
    bool_or(r."supersededByRowId" IS NOT NULL) AS superseded,
    min(COALESCE(own.shortcode, legacy.shortcode)) AS shortcode
  FROM "SourceTransactionRecord" r
  LEFT JOIN ${LIVE_REFS} own
    ON own.source = r.source AND own."externalId" = r."externalId"
  LEFT JOIN ${LIVE_REFS} legacy
    ON legacy.source = r.source AND legacy."externalId" = r."legacyReference"
  WHERE ${notDeleted("r")} AND (${scope})

  GROUP BY r.source, ${chargeKeyOf("r")}
)`;

export const CHARGE_STATE = chargeStateOf(sql`true`);

export const OCCURRENCE_IDENTITY_REVIEW =
  "This statement observation has no proven source occurrence. Review its original evidence before creating or attaching a transaction.";

/** Membership and equal bank facts cannot establish an independent occurrence. */
export function hasStatementOccurrence(row: {
  providerTransactionId: string | null;
  rowPosition: number | null;
}): boolean {
  return Boolean(row.providerTransactionId) || row.rowPosition !== null;
}

/** Settlement-ref keys stored on a suggestion's projection, `source:externalId`. */
export const suggestionRefKey = (source: string, externalId: string) =>
  `${source}:${externalId}`;

/** A projection field of a statement suggestion's AssessmentState row. */
export const suggestionField = (
  key:
    | "source"
    | "chargeKey"
    | "accountId"
    | "month"
    | "statementDate"
    | "amount"
    | "recommended"
    | "clean"
    | "evidenceFingerprint"
    | "needsLabel",
  alias = "s",
) => sql`${sql.raw(`"${alias}"`)}.data->>${key}`;

/**
 * Current unsettled evidence gates reads as well as discovery. Schema-owned
 * family/status literals preserve partial-index admission in generic plans;
 * caller values remain parameters. No retirement scan is required.
 * Account-scoped readers use indexed probes and short-circuit on eligibility.
 */
export const pendingSuggestion = (alias = "s") =>
  sql`${sql.raw(`"${alias}"`)}.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    AND ${sql.raw(`"${alias}"`)}.active
    AND ${sql.raw(`"${alias}"`)}.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
    AND ${sql`EXISTS (SELECT 1 FROM "SourceTransactionRecord" head
      WHERE head.source=${suggestionField("source", alias)}
        AND head."externalId"=${sql.raw(`"${alias}"`)}.data->>'headRef'
        AND head.current AND (head."withdrawnAt" IS NULL OR ${sql.raw(`"${alias}"`)}.data->>'reviewReason' IS NOT NULL)
        AND ${notDeleted("head")})`}
    -- includes-deleted: removed observations invalidate current advice.
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${sql.raw(`"${alias}"`)}.data->'refs') ref(value)
      WHERE (
        ${sql.raw(`"${alias}"`)}.data->>'recommended' NOT IN (${statementTransactionAction.enum.void}, ${statementTransactionAction.enum.book})
        AND EXISTS (SELECT 1 FROM "EntityExternalId" e WHERE e.kind='settlement_ref' AND ${notDeleted("e")}
          AND e.source=split_part(ref.value,':',1) AND e."externalId"=substr(ref.value,strpos(ref.value,':')+1))
      )
      -- includes-deleted: removed observations invalidate current advice.
      OR ${sql`-- includes-deleted: removed observations invalidate current advice.
      EXISTS (
        SELECT 1 FROM "SourceTransactionRecord" r WHERE r.source=split_part(ref.value,':',1)
          AND r."externalId"=substr(ref.value,strpos(ref.value,':')+1)
          AND (r."deletedAt" IS NOT NULL OR r.disposition=${sourceTransactionRecordDisposition.enum.ignored} OR r."supersededByRowId" IS NOT NULL)
      )`}
    )`;

import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record";
import { statementTransactionAction } from "@cubby/schemas/statement-suggestion";
import { type SQL, isNull, sql } from "drizzle-orm";

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
 * Sparse readers keep indexed probes; population reads share hashable sets.
 */
export const pendingSuggestion = (
  alias = "s",
  options: { populationRead?: boolean } = {},
) =>
  sql`${sql.raw(`"${alias}"`)}.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    AND ${sql.raw(`"${alias}"`)}.active
    AND ${sql.raw(`"${alias}"`)}.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
    AND ${
      options.populationRead
        ? sql`(
      (${suggestionField("source", alias)}, ${sql.raw(`"${alias}"`)}.data->>'headRef') IN (
        SELECT head.source, head."externalId" FROM "SourceTransactionRecord" head
        WHERE head.current AND head."withdrawnAt" IS NULL AND ${isNull(sql`head."deletedAt"`)}
      ) OR (${sql.raw(`"${alias}"`)}.data->>'reviewReason' IS NOT NULL AND
        (${suggestionField("source", alias)}, ${sql.raw(`"${alias}"`)}.data->>'headRef') IN (
          SELECT head.source, head."externalId" FROM "SourceTransactionRecord" head
          WHERE head.current AND ${isNull(sql`head."deletedAt"`)}
        ))
    )`
        : sql`EXISTS (SELECT 1 FROM "SourceTransactionRecord" head
      WHERE head.source=${suggestionField("source", alias)}
        AND head."externalId"=${sql.raw(`"${alias}"`)}.data->>'headRef'
        AND head.current AND (head."withdrawnAt" IS NULL OR ${sql.raw(`"${alias}"`)}.data->>'reviewReason' IS NOT NULL)
        AND ${notDeleted("head")})`
    }
    -- includes-deleted: removed observations invalidate current advice.
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(${sql.raw(`"${alias}"`)}.data->'refs') ref(value)
      WHERE (
        ${sql.raw(`"${alias}"`)}.data->>'recommended' NOT IN (${statementTransactionAction.enum.void}, ${statementTransactionAction.enum.book})
        AND EXISTS (SELECT 1 FROM "EntityExternalId" e WHERE e.kind='settlement_ref' AND ${notDeleted("e")}
          AND e.source=split_part(ref.value,':',1) AND e."externalId"=substr(ref.value,strpos(ref.value,':')+1))
      )
      -- includes-deleted: removed observations invalidate current advice.
      -- The uncorrelated set can be hashed once for a population read, rather
      -- than probing source evidence for every ref of every pending suggestion.
      OR ${
        options.populationRead
          ? sql`(split_part(ref.value,':',1), substr(ref.value,strpos(ref.value,':')+1)) IN (
        SELECT r.source, r."externalId" FROM "SourceTransactionRecord" r
        WHERE r."deletedAt" IS NOT NULL OR r.disposition=${sourceTransactionRecordDisposition.enum.ignored} OR r."supersededByRowId" IS NOT NULL
      )`
          : sql`-- includes-deleted: removed observations invalidate current advice.
      EXISTS (
        SELECT 1 FROM "SourceTransactionRecord" r WHERE r.source=split_part(ref.value,':',1)
          AND r."externalId"=substr(ref.value,strpos(ref.value,':')+1)
          AND (r."deletedAt" IS NOT NULL OR r.disposition=${sourceTransactionRecordDisposition.enum.ignored} OR r."supersededByRowId" IS NOT NULL)
      )`
      }
    )`;

/** Population counts need eligibility and routing, not each proposal's full
 * candidate evidence. Decode its JSON once and retain a compact statement-local
 * projection so repeated eligibility predicates do not detoast it per field. */
// oxlint-disable-next-line cubby/no-raw-enum-literal-in-sql -- source is a JSON property name, not a vocabulary value.
export const pendingStatementStateSql = (scope?: SQL): SQL => sql`
  SELECT s.family, s.active, s.status,
    jsonb_strip_nulls(jsonb_build_object(
      'source', fields.source, 'headRef', fields."headRef",
      'recommended', fields.recommended, 'refs', fields.refs,
      'reviewReason', fields."reviewReason", 'accountId', fields."accountId", 'clean', fields.clean
    )) AS data
  FROM "AssessmentState" s
  CROSS JOIN LATERAL jsonb_to_record(s.data) AS fields(
    source text, "headRef" text, recommended text, refs jsonb,
    "reviewReason" text, "accountId" text, clean boolean
  )
  WHERE s.family = ${sqlEnumConstant(assessmentFamily, assessmentFamily.enum.statement_transaction)}
    AND s.active AND s.status = ${sqlEnumConstant(suggestionStatus, suggestionStatus.enum.pending)}
    ${scope ? sql`AND (${scope})` : sql``}
`;

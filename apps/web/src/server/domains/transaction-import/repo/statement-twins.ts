import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sourceTransactionRecordDisposition } from "@cubby/schemas/source-transaction-record-fields";
import { sql, type SQL } from "drizzle-orm";

import { sourceOccurrenceHasUnresolvedHistory } from "~/server/db/computed/source-occurrence-history-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import type { ChargeRef } from "~/server/domains/transaction-import/repo/statement-input";

// Only the facts used by twin grouping and its ownership fence.
const twinFacts = sql`(
  -- includes-deleted: retained records and occurrence decisions participate in matching.
  SELECT r.*, o.shortcode AS "chargeKey", o."accountId", o."withdrawnAt",
    o."acceptedTransactionId", o.disposition, o."reviewState" AS "storedReviewState",
    COALESCE(o."currentObservationId" = r.id, false) AS current,
    CASE WHEN o."replacementObservationId" IS NOT NULL THEN o."replacementObservationId"
      WHEN r.id <> o."currentObservationId" AND a."supersededByObservationId" = o."currentObservationId" THEN a."supersededByObservationId"
      ELSE NULL END AS "supersededByRowId"
  FROM "SourceTransactionRecord" r JOIN "SourceOccurrence" o ON o.id=r."occurrenceId"
  LEFT JOIN "SourceObservationAnnotation" a ON a."observationId"=r.id
)`;

export type ExactTwin = {
  source: string;
  thinner: SourceTransactionRecordId;
  thinnerChargeKey: string;
  successor: SourceTransactionRecordId;
  successorChargeKey: string;
};

/**
 * Same-source groups where every live charge with identical account, date,
 * amounts, description and merchant is unbooked and ready, and provider-ID
 * rows and ID-less rows from other imports are equal in number: an export
 * without provider IDs re-recorded those provider rows. Pairing within a
 * group is arbitrary because the members' facts are identical. An occurrence
 * whose replacement was ever decided, including a cleared automatic one, is
 * never a candidate again.
 */
export function exactTwinsSql(charges: SQL) {
  return sql`
    WITH seed AS MATERIALIZED (
      SELECT DISTINCT r.source, r."accountId", normalize(r."accountDescriptor", NFKC) AS descriptor,
        r."statementDate", r."amountMinor", r."providerAmountMinor", r."rawDescription", r.merchant
      FROM ${twinFacts} r
      WHERE (r.source, r."chargeKey") IN (${charges}) AND r.current AND ${notDeleted("r")}
        AND btrim(coalesce(r."rawDescription", '')) <> ''
    ),
    members AS MATERIALIZED (
      SELECT seed.*, r.id, r."chargeKey", r."batchId", r."providerTransactionId" IS NOT NULL AS provider,
        (r."withdrawnAt" IS NULL AND r."acceptedTransactionId" IS NULL
          AND r.disposition <> ${sourceTransactionRecordDisposition.enum.ignored}
          AND r."supersededByRowId" IS NULL
          AND r."storedReviewState" = ${sourceOccurrenceReviewState.enum.ready}
          AND NOT ${sourceOccurrenceHasUnresolvedHistory(sql`r."occurrenceId"`, sql`r."acceptedTransactionId"`)}
          AND EXISTS (SELECT 1 FROM "SourceOccurrence" owner WHERE owner.id = r."occurrenceId" AND ${notDeleted("owner")}
            AND owner."supersededByOccurrenceId" IS NULL AND owner."replacementObservationId" IS NULL)
          -- A replacement anyone already set or cleared is a decision, not a candidate.
          AND NOT EXISTS (SELECT 1 FROM "AuditLog" decided WHERE decided."entityKind" = 'sourceOccurrence'
            AND decided."entityId" = r."occurrenceId" AND decided.changes ? 'supersededByOccurrenceId')) AS open
      FROM seed JOIN ${twinFacts} r ON r.source = seed.source AND r.current AND ${notDeleted("r")}
        AND r."accountId" IS NOT DISTINCT FROM seed."accountId"
        AND normalize(r."accountDescriptor", NFKC) = seed.descriptor
        AND r."statementDate" = seed."statementDate" AND r."amountMinor" = seed."amountMinor"
        AND r."providerAmountMinor" = seed."providerAmountMinor"
        AND r."rawDescription" = seed."rawDescription" AND r.merchant IS NOT DISTINCT FROM seed.merchant
    ),
    groups AS MATERIALIZED (
      SELECT source, "accountId", descriptor, "statementDate", "amountMinor", "providerAmountMinor", "rawDescription", merchant
      FROM members
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      HAVING bool_and(open)
        AND count(*) FILTER (WHERE provider) = count(*) FILTER (WHERE NOT provider)
        AND count(*) FILTER (WHERE provider) > 0
        AND NOT (array_agg(DISTINCT "batchId") FILTER (WHERE provider) && array_agg(DISTINCT "batchId") FILTER (WHERE NOT provider))
    ),
    ranked AS (
      SELECT m.*, row_number() OVER (PARTITION BY m.source, m."accountId", m.descriptor, m."statementDate",
          m."amountMinor", m."providerAmountMinor", m."rawDescription", m.merchant, m.provider ORDER BY m.id) AS k
      FROM members m JOIN groups g ON g.source = m.source AND g."accountId" IS NOT DISTINCT FROM m."accountId"
        AND g.descriptor = m.descriptor AND g."statementDate" = m."statementDate" AND g."amountMinor" = m."amountMinor"
        AND g."providerAmountMinor" = m."providerAmountMinor" AND g."rawDescription" = m."rawDescription"
        AND g.merchant IS NOT DISTINCT FROM m.merchant
    )
    SELECT thin.source, thin.id AS thinner, thin."chargeKey" AS "thinnerChargeKey", full_row.id AS successor, full_row."chargeKey" AS "successorChargeKey"
    FROM ranked thin JOIN ranked full_row ON full_row.provider AND NOT thin.provider AND full_row.k = thin.k
      AND full_row.source = thin.source AND full_row."accountId" IS NOT DISTINCT FROM thin."accountId"
      AND full_row.descriptor = thin.descriptor AND full_row."statementDate" = thin."statementDate"
      AND full_row."amountMinor" = thin."amountMinor" AND full_row."providerAmountMinor" = thin."providerAmountMinor"
      AND full_row."rawDescription" = thin."rawDescription" AND full_row.merchant IS NOT DISTINCT FROM thin.merchant
    ORDER BY thin.id`;
}

export const chargeValues = (charges: readonly ChargeRef[]) =>
  sql.join(
    charges.map((charge) => sql`(${charge.source}, ${charge.chargeKey})`),
    sql`, `,
  );

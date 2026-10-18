import { suggestionStatus } from "@cubby/schemas/ai";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { statementRowDisposition } from "@cubby/schemas/statement-row";
import { sql } from "drizzle-orm";

/**
 * Every live settlement reference with its transaction's shortcode — the
 * `(source, externalId)` pairs a statement row matches on.
 *
 * Joined once and hashed rather than probed per row: cost scales with the
 * references (~6k) rather than with StatementRow (~34k).
 *
 * LOAD-BEARING: joining without DISTINCT is safe because the live
 * `EntityExternalId_source_kind_externalId_key` unique allows one live owner
 * per `(source, 'settlement_ref', externalId)`. The transaction must be live
 * too: its references are soft-deleted with it, and the join says so again.
 */
export const LIVE_REFS = sql`(
  SELECT fx."source" AS source, fx."externalId" AS "externalId", ft.shortcode
  FROM "EntityExternalId" fx
  JOIN "FinancialTransaction" ft ON ft."id" = fx."entityId" AND ft."deletedAt" IS NULL
  WHERE fx."kind" = 'settlement_ref' AND fx."deletedAt" IS NULL
)`;

/**
 * One provider charge's identity: its frozen v1 content hash. Every
 * re-export records a new v2 occurrence of the same charge, and each carries
 * that hash as `legacyExternalId`; a row recorded before occurrence ids has
 * the hash as its own `externalId`.
 */
export const chargeKeyOf = (alias: string) =>
  sql.raw(`COALESCE(${alias}."legacyExternalId", ${alias}."externalId")`);

/**
 * Charge-level state over ALL live observations of a source, never a filtered
 * subset: a decision recorded on one observation (an ignore, a supersession,
 * a matched ref — including a ref equal to the charge's v1 hash) settles every
 * other observation of the same charge.
 */
export const CHARGE_STATE = sql`(
  SELECT r.source, ${chargeKeyOf("r")} AS "chargeKey",
    bool_or(r.disposition = ${statementRowDisposition.enum.ignored}) AS ignored,
    bool_or(r."supersededByRowId" IS NOT NULL) AS superseded,
    min(COALESCE(own.shortcode, legacy.shortcode)) AS shortcode
  FROM "StatementRow" r
  LEFT JOIN ${LIVE_REFS} own
    ON own.source = r.source AND own."externalId" = r."externalId"
  LEFT JOIN ${LIVE_REFS} legacy
    ON legacy.source = r.source AND legacy."externalId" = r."legacyExternalId"
  WHERE r."deletedAt" IS NULL
  GROUP BY r.source, ${chargeKeyOf("r")}
)`;

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

/** Pending, active statement suggestions under `alias`. */
export const pendingSuggestion = (alias = "s") =>
  sql`${sql.raw(`"${alias}"`)}.family = ${assessmentFamily.enum.statement_transaction}
    AND ${sql.raw(`"${alias}"`)}.active
    AND ${sql.raw(`"${alias}"`)}.status = ${suggestionStatus.enum.pending}`;

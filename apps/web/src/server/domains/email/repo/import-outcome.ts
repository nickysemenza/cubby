import {
  emailImportOutcome,
  emailImportOutcomeDetail,
  mailImportGapCategory,
  MAIL_IMPORT_GAP_EXECUTOR,
  MAIL_IMPORT_GAP_OUTCOME,
  type EmailImportOutcome,
  type EmailImportOutcomeDetail,
} from "@cubby/schemas/email-fields";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { mailImportOutcome } from "@cubby/schemas/suggestion";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { notDeleted } from "~/server/db/helpers/predicates";
import type { RepositoryQueryInput } from "~/server/db/repository-access.boundary";
import { repositoryQueries as unwrapDb } from "~/server/db/repository-access.boundary";

const OUTCOME = emailImportOutcome.enum;
// The judgment's JSON keys, bound as parameters rather than SQL vocabulary.
const JUDGMENT_KIND = "kind";
const GAP_CATEGORY = "category";
type Judgment = z.infer<typeof mailImportOutcome>;
/** A settled judgment's outcome; an unresolved one routes by its gap. */
const SETTLED_JUDGMENT_OUTCOME = {
  imported: OUTCOME.imported,
  linked: OUTCOME.linked,
  unrelated: OUTCOME.unrelated,
} as const satisfies Record<
  Exclude<Judgment["kind"], "unresolved">,
  EmailImportOutcome
>;
const judgmentOutcome = (judgment: Judgment): EmailImportOutcome =>
  judgment.kind === "unresolved"
    ? MAIL_IMPORT_GAP_OUTCOME[MAIL_IMPORT_GAP_EXECUTOR[judgment.category]]
    : SETTLED_JUDGMENT_OUTCOME[judgment.kind];

/** The import outcome an unresolved gap category routes to, as SQL over its text. */
const gapOutcomeSql = (category: SQL): SQL =>
  sql`CASE ${category} ${sql.join(
    mailImportGapCategory.options.map(
      (value) =>
        sql`WHEN ${value}::text THEN ${MAIL_IMPORT_GAP_OUTCOME[MAIL_IMPORT_GAP_EXECUTOR[value]]}::text`,
    ),
    sql` `,
  )} ELSE ${MAIL_IMPORT_GAP_OUTCOME[MAIL_IMPORT_GAP_EXECUTOR.unknown]}::text END`;

/**
 * The newest retained Mail import outcome for the correlated `"Email"` at its
 * current checksum (`RunOperation_mail_outcome_email_idx`).
 */
const newestOutcome = (column: SQL) => sql`(SELECT ${column}
  FROM "RunOperation" o
  WHERE o.kind = ${"target_outcome"} AND (o.result->'mailOutcome') IS NOT NULL
    AND (o.result #>> '{target,entityId}') = "Email".id::text
    AND o.result #>> '{mailOutcome,checksum}' = "Email".checksum
  ORDER BY o."completedAt" DESC NULLS LAST, o.id DESC LIMIT 1)`;

/** The holding Mail import Run recorded no outcome for the Email's current checksum. */
const holderWithoutOutcome = sql`h.purpose = ${runPurpose.enum.mail_import} AND NOT EXISTS (
  SELECT 1 FROM "RunOperation" o
  WHERE o."runId" = h.id AND o.kind = ${"target_outcome"} AND (o.result->'mailOutcome') IS NOT NULL
    AND (o.result #>> '{target,entityId}') = "Email".id::text
    AND o.result #>> '{mailOutcome,checksum}' = "Email".checksum)`;

/**
 * A reviewed link of the correlated `"Email"` at its current checksum: an
 * active `linked` decision on a current order event, to a live Purchase.
 */
const reviewedLink = sql`EXISTS (SELECT 1 FROM "EmailPurchaseDecision" d
  JOIN "OrderMailEvent" e ON e.id = d."eventId" AND e."supersededAt" IS NULL
  JOIN "Purchase" p ON p.id = d."purchaseId" AND ${notDeleted("p")}
  WHERE e."orderMailId" = "Email"."orderMailId" AND d.active
    AND d.decision = ${"linked"} AND d."evidenceChecksum" = "Email".checksum)`;

/**
 * Accepted source facts mean imported. A holding Mail import Run without an
 * outcome for this checksum reads importing while active. A reviewed link at
 * this checksum then reads linked, unless the newest outcome imported the
 * Email (accepted facts may publish later): it settles an earlier unresolved
 * outcome and an ended holder alike. An ended holder without an outcome reads failed.
 * Otherwise the newest retained outcome decides, an unresolved gap by who
 * settles it; with none, confirmed absent facts read not imported.
 */
export const emailImportOutcomeSql = (accepted: SQL): SQL<string | null> => {
  const judgment = newestOutcome(sql`o.result #> '{mailOutcome,judgment}'`);
  const activeHolder = sql`h.status IN (${sql.join(
    ACTIVE_RUN_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )}, ${runStatus.enum.paused_offline})`;
  return sql`CASE
  WHEN ${accepted} IS TRUE THEN ${OUTCOME.imported}::text
  ELSE coalesce(
    (SELECT ${OUTCOME.importing}::text FROM "Run" h
      WHERE h.id = "Email"."runId" AND ${holderWithoutOutcome} AND ${activeHolder}),
    CASE WHEN ${reviewedLink} AND ${judgment} ->> ${JUDGMENT_KIND}::text IS DISTINCT FROM ${"imported"}
      THEN ${OUTCOME.linked}::text END,
    (SELECT ${OUTCOME.failed}::text FROM "Run" h
      WHERE h.id = "Email"."runId" AND ${holderWithoutOutcome} AND NOT (${activeHolder})),
    (SELECT CASE j->>${JUDGMENT_KIND}::text ${sql.join(
      Object.entries(SETTLED_JUDGMENT_OUTCOME).map(
        ([kind, outcome]) => sql`WHEN ${kind}::text THEN ${outcome}::text`,
      ),
      sql` `,
    )}
      ELSE ${gapOutcomeSql(sql`coalesce(j->>${GAP_CATEGORY}::text, ${mailImportGapCategory.enum.unknown})`)}
      END FROM (SELECT ${judgment} AS j) newest WHERE j IS NOT NULL),
    CASE WHEN ${accepted} IS FALSE THEN ${OUTCOME.not_imported}::text END)
  END`;
};

const outcomeRow = z.object({
  id: z.string(),
  outcome: emailImportOutcome.nullable(),
  judgment: mailImportOutcome.nullable(),
  outcomeRun: z.string().nullable(),
  holderRun: z.string().nullable(),
  waitingEmail: z.string().nullable(),
  waitingVendor: z.string().nullable(),
});

/**
 * Each Email's import outcome with its reason: run, gap category, who settles
 * it and the source it waits on, by public codes. Absent when unavailable.
 */
export async function loadEmailImportOutcomes(
  db: RepositoryQueryInput,
  rows: readonly { id: string; accepted: boolean | null }[],
): Promise<Map<string, EmailImportOutcomeDetail>> {
  if (rows.length === 0) return new Map();
  const result = await unwrapDb(db).execute(
    sql`
    SELECT "Email".id, outcome.value AS outcome, newest.judgment, newest.run AS "outcomeRun",
      holder.shortcode AS "holderRun", waiting_email.shortcode AS "waitingEmail",
      waiting_vendor.shortcode AS "waitingVendor"
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS accepted(id uuid, accepted boolean)
    JOIN "Email" ON "Email".id = accepted.id
    CROSS JOIN LATERAL (SELECT ${emailImportOutcomeSql(sql`accepted.accepted`)} AS value) outcome
    LEFT JOIN LATERAL (SELECT o.result #> '{mailOutcome,judgment}' AS judgment, r.shortcode AS run
      FROM "RunOperation" o JOIN "Run" r ON r.id = o."runId"
      WHERE o.kind = ${"target_outcome"} AND (o.result->'mailOutcome') IS NOT NULL
        AND (o.result #>> '{target,entityId}') = "Email".id::text
        AND o.result #>> '{mailOutcome,checksum}' = "Email".checksum
      ORDER BY o."completedAt" DESC NULLS LAST, o.id DESC LIMIT 1) newest ON true
    LEFT JOIN "Run" holder ON holder.id = "Email"."runId"
    LEFT JOIN "Entity" waiting_email ON waiting_email.id::text = newest.judgment #>> '{waitingOn,emailId}'
    LEFT JOIN "Entity" waiting_vendor ON waiting_vendor.id::text = newest.judgment #>> '{waitingOn,vendorId}'`,
    "objects",
  );
  const outcomes = new Map<string, EmailImportOutcomeDetail>();
  for (const row of z.array(outcomeRow).parse(result)) {
    if (row.outcome === null) continue;
    const fromRun =
      row.outcome === OUTCOME.importing || row.outcome === OUTCOME.failed;
    // Accepted facts or the holding Run may decide over the newest judgment.
    const judgment =
      row.judgment && judgmentOutcome(row.judgment) === row.outcome
        ? row.judgment
        : null;
    const unresolved = judgment?.kind === "unresolved" ? judgment : null;
    const waitingOn = unresolved?.waitingOn ?? null;
    outcomes.set(
      row.id,
      emailImportOutcomeDetail.parse({
        outcome: row.outcome,
        category: unresolved?.category ?? null,
        executor: unresolved
          ? MAIL_IMPORT_GAP_EXECUTOR[unresolved.category]
          : null,
        reason:
          judgment?.kind === "unresolved" || judgment?.kind === "unrelated"
            ? judgment.reason
            : null,
        waitingOn:
          waitingOn?.kind === "email" && row.waitingEmail
            ? { kind: "email", emailId: row.waitingEmail }
            : waitingOn?.kind === "order"
              ? {
                  kind: "order",
                  orderId: waitingOn.orderId,
                  vendorId: row.waitingVendor,
                }
              : null,
        runId: judgment ? row.outcomeRun : fromRun ? row.holderRun : null,
      }),
    );
  }
  return outcomes;
}

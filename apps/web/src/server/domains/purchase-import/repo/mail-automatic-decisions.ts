import {
  suggestionJudgments,
  feedbackAuthority,
  mailDecisionFamily,
  type MailDecisionFamily,
} from "@cubby/schemas/suggestion";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";

type DecisionValue = z.infer<ReturnType<typeof z.json>>;

/** How each mail family reads in the automation history. */
export const mailDecisionPresentation = {
  email_relevance: {
    summarize: (value: DecisionValue) =>
      `Classified ${suggestionJudgments.email_relevance.parse(value).classification}`,
    correction: {
      label: "Correct relevance",
      options: [
        { label: "Related", value: "related" },
        { label: "Unrelated", value: "unrelated" },
        { label: "Uncertain", value: "uncertain" },
      ],
    },
  },
  email_link: {
    summarize: (value: DecisionValue) =>
      `Email link ${suggestionJudgments.email_link.parse(value).decision}`,
    correction: {
      label: "Correct link decision",
      options: [
        { label: "Link", value: { decision: "linked" } },
        { label: "Dismiss link", value: { decision: "dismissed" } },
      ],
    },
  },
  mail_import_outcome: {
    summarize: (value: DecisionValue) => {
      const outcome = suggestionJudgments.mail_import_outcome.parse(value);
      return outcome.kind === "imported"
        ? `Imported ${outcome.lines.map((line) => line.name).join(", ")}`
        : outcome.kind === "linked"
          ? `Linked ${outcome.event}`
          : `${outcome.kind}: ${outcome.reason}`;
    },
  },
} satisfies Record<
  MailDecisionFamily,
  {
    summarize: (value: DecisionValue) => string;
    correction?: {
      label: string;
      options: { label: string; value: DecisionValue }[];
    };
  }
>;

const ref = (entity: string, id: SQL) =>
  sql`jsonb_build_object('entity', ${entity}::text, 'id', (${id})::text)`;

/** The latest member grade of a handle, excluding its decision and receipts. */
const latestReview = (subject: SQL) => sql`LEFT JOIN LATERAL (
    SELECT r.id, r.verdict, r."createdAt" FROM "EmailReview" r
    WHERE r."subjectId" = ${subject} AND r.authority = ${feedbackAuthority.enum.member}
      AND r."operationId" <> ${"decision"}
      AND r.metadata->>${"kind"} IS DISTINCT FROM ${"assessment_application"}
    ORDER BY r."createdAt" DESC, r.id DESC LIMIT 1) latest ON true`;

const liveMailOf = (original: SQL) =>
  sql`(SELECT mail.id FROM "Email" mail WHERE mail."orderMailId" = ${original} AND ${notDeleted("mail")} LIMIT 1)`;

/** The stated scope of an automation read; absent names no record scope. */
export type MailDecisionScope = {
  emailIds: readonly string[];
  purchaseIds: readonly string[];
} | null;

const anyOf = (column: SQL, ids: readonly string[]) =>
  ids.length ? sql`${column} = ANY(${uuidArrayParam(ids)})` : sql`false`;

/** A prediction routing used, or one from before that was recorded. */
function relevanceBranch(scope: MailDecisionScope, reviewFilter: SQL) {
  const handle = sql`o.id`;
  return sql`
    SELECT o.id, ${"email_relevance"}::text AS family,
      jsonb_build_object('classification', o.classification, 'stage', o.stage) AS judgment,
      o."createdAt", o.checksum AS fingerprint, NULL::text AS "automaticRule",
      (o.application = ${"applied"}) AS "applicationVerified",
      latest.verdict, latest."createdAt" AS "reviewedAt", true AS active,
      CASE WHEN EXISTS (SELECT 1 FROM "EmailReview" applied
        WHERE applied."subjectId" = o.id AND applied.metadata->>${"kind"} = ${"assessment_application"})
        THEN ${"applied"} ELSE ${"pending"} END AS status,
      o."createdAt" AS "sortAt",
      jsonb_build_array(${ref("email", sql`o."emailId"`)}) AS refs
    FROM "EmailClassificationObservation" o
    ${latestReview(handle)}
    WHERE o.application IN (${"applied"}, ${"unverified"})
      AND NOT EXISTS (SELECT 1 FROM "EmailReview" resolved
        WHERE resolved."subjectId" = o.id AND resolved."operationId" = ${"resolution"}
          AND resolved.authority = ${feedbackAuthority.enum.member})
      ${scope ? sql`AND ${anyOf(sql`o."emailId"`, scope.emailIds)}` : sql``}
      ${reviewFilter}`;
}

function linkBranch(scope: MailDecisionScope, reviewFilter: SQL) {
  const mail = sql`COALESCE(d."emailId", ${liveMailOf(sql`d."originalId"`)})`;
  return sql`
    SELECT d.id, ${"email_link"}::text AS family,
      jsonb_build_object(${suggestionJudgments.email_link.keyof().enum.decision}::text, d.decision) AS judgment,
      d."createdAt", d."evidenceChecksum" AS fingerprint, NULL::text AS "automaticRule",
      true AS "applicationVerified",
      latest.verdict, latest."createdAt" AS "reviewedAt", d.active, d.status,
      d."createdAt" AS "sortAt",
      jsonb_build_array(${ref("email", mail)}, ${ref("purchase", sql`d."purchaseId"`)}) AS refs
    FROM "EmailPurchaseDecision" d
    ${latestReview(sql`d.id`)}
    WHERE d.authority = ${feedbackAuthority.enum.automatic}
      ${
        scope
          ? sql`AND (${anyOf(sql`d."purchaseId"`, scope.purchaseIds)}
              OR ${anyOf(sql`d."emailId"`, scope.emailIds)}
              OR (d."emailId" IS NULL AND ${anyOf(liveMailOf(sql`d."originalId"`), scope.emailIds)}))`
          : sql``
      }
      ${reviewFilter}`;
}

function outcomeBranch(scope: MailDecisionScope, reviewFilter: SQL) {
  const handle = sql`(op.result #>> '{mailOutcome,id}')::uuid`;
  const target = sql`(op.result #>> '{target,entityId}')::uuid`;
  const createdAt = sql`((op.result #>> '{mailOutcome,createdAt}')::timestamptz AT TIME ZONE 'UTC')`;
  // The Email's linked Purchases, from either its id or its retained original.
  const linked = sql`"EmailPurchaseDecision" link
    WHERE link.active AND link.decision = ${"linked"} AND EXISTS (
      SELECT 1 FROM "Email" mail WHERE mail.id = ${target} AND ${notDeleted("mail")}
        AND (link."emailId" = mail.id OR link."originalId" = mail."orderMailId"))`;
  return sql`
    SELECT ${handle} AS id, ${"mail_import_outcome"}::text AS family,
      op.result #> '{mailOutcome,judgment}' AS judgment,
      ${createdAt} AS "createdAt", op.result #>> '{mailOutcome,fingerprint}' AS fingerprint,
      NULL::text AS "automaticRule", true AS "applicationVerified",
      latest.verdict, latest."createdAt" AS "reviewedAt", true AS active, ${"pending"} AS status,
      ${createdAt} AS "sortAt",
      jsonb_build_array(${ref("email", target)})
        || COALESCE((SELECT jsonb_agg(${ref("purchase", sql`link."purchaseId"`)}) FROM ${linked}), '[]'::jsonb) AS refs
    FROM "RunOperation" op
    ${latestReview(handle)}
    WHERE op.kind = ${"target_outcome"} AND (op.result->'mailOutcome') IS NOT NULL
      ${
        scope
          ? sql`AND (${anyOf(target, scope.emailIds)}
              OR (${scope.purchaseIds.length > 0} AND EXISTS (SELECT 1 FROM ${linked}
                AND ${anyOf(sql`link."purchaseId"`, scope.purchaseIds)})))`
          : sql``
      }
      ${reviewFilter}`;
}

/** One SELECT per included mail family, columns matching the Suggestion branch. */
export function mailAutomaticDecisionBranches(input: {
  family?: MailDecisionFamily;
  scope: MailDecisionScope;
  reviewFilter: SQL;
}): SQL[] {
  const builders = {
    email_relevance: relevanceBranch,
    email_link: linkBranch,
    mail_import_outcome: outcomeBranch,
  };
  return (input.family ? [input.family] : mailDecisionFamily.options).map(
    (family) => builders[family](input.scope, input.reviewFilter),
  );
}

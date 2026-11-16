import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import {
  decisionChannel,
  decisionKind,
  decisionActorKind,
} from "@cubby/schemas/kernel/stage";
import { feedbackAuthority } from "@cubby/schemas/suggestion";
import { sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  emailReview,
  emailPurchaseDecision,
  emailFinancialAssociation,
} from "~/server/db/retained-tables";
import { decisionProjectionColumns } from "~/server/domains/email/repo/decision-projection";

/** Current member links projected from decision slots, including their original evidence. */
export const emailLinkDecisionsSql = sql`(
  WITH current AS (
    SELECT DISTINCT ON (subject, slot) * FROM "Decision"
    WHERE channel=${decisionChannel.enum.assignment} ORDER BY subject, slot, at DESC, id DESC
  ) SELECT DISTINCT ON (d.subject, coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid))
    d.id, (d.value->>'eventId')::uuid AS "eventId",
    coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid) AS "purchaseId",
    d.value->>${"decision"} AS decision,
    d.value->>'evidenceChecksum' AS "evidenceChecksum", d."actorId" AS "decidedByUserId",
    d.value->>'proposedBy' AS "proposedBy", CASE WHEN d."actorKind"=${decisionActorKind.enum.member} THEN ${feedbackAuthority.enum.member} ELSE ${feedbackAuthority.enum.automatic} END AS authority,
    coalesce(review.value #>> '{}',${"resolved"}) AS status,
    ((d.value->>${"active"})::boolean IS DISTINCT FROM false AND
      live_purchase.id IS NOT NULL AND live_email.id IS NOT NULL AND
      (d.value->>${"decision"}=${emailLinkEvidenceKind.enum.dismissed} OR
        coalesce(event_target."mergedIntoId",event_target.id,pointer_target."mergedIntoId",pointer_target.id) = live_purchase.id)) AS active,
    live_email.id AS "emailId", (d.value->>'originalId')::uuid AS "originalId",
    NULL::jsonb AS producer, d.at AS "createdAt", d.at AS "updatedAt"
  FROM current d LEFT JOIN current pointer ON pointer.subject=d.subject AND pointer.field='purchaseId'
  LEFT JOIN current event_pointer ON event_pointer.subject='emailEvent:' || (d.value->>'eventId') AND event_pointer.field='purchaseId'
  LEFT JOIN "Entity" target ON target.id=substring(d.field from 6)::uuid
  LEFT JOIN "Entity" pointer_target ON pointer_target.id=(pointer.value#>>'{}')::uuid AND pointer.kind=${decisionKind.enum.set}
  LEFT JOIN "Entity" event_target ON event_target.id=(event_pointer.value#>>'{}')::uuid AND event_pointer.kind=${decisionKind.enum.set}
  LEFT JOIN "Purchase" live_purchase ON live_purchase.id=coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid) AND ${notDeleted("live_purchase")}
  LEFT JOIN "Email" live_email ON live_email.id=substring(d.subject from 7)::uuid AND ${notDeleted("live_email")}
  LEFT JOIN current review ON review.subject=d.subject AND review.field='review-status:' || d.id
  WHERE d.subject LIKE 'email:%' AND d.field LIKE 'link:%' AND d.kind=${decisionKind.enum.set}
  ORDER BY d.subject, coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid), active DESC,
    (d.value->>${"decision"}=${emailLinkEvidenceKind.enum.linked}) DESC,
    (substring(d.field from 6)::uuid=coalesce(target."mergedIntoId",target.id)) DESC,d.id
 )`;
const emailLinkDecisionsFrom = sql`${emailLinkDecisionsSql} "EmailPurchaseDecision"`;
export const emailLinkDecisionsRead = new QueryBuilder()
  .select(decisionProjectionColumns(emailPurchaseDecision))
  .from(emailLinkDecisionsFrom)
  .as("EmailPurchaseDecision");

/** Decision history projected with the review contract; retained tables are not read. */
export const emailReviewsSql = sql`(
  SELECT d.id, d.at AS "createdAt", r.*
  FROM "Decision" d CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(d.value)='object' THEN d.value ELSE '{}'::jsonb END) AS r(
    family text, "subjectId" uuid, "emailId" uuid, "originalId" uuid,
    checksum text, classification text, "operationId" text, verdict text,
    correction jsonb, reason text, evidence jsonb, intent text, authority text,
    "actorUserId" text, subject jsonb, receipt jsonb, metadata jsonb)
  WHERE d.channel=${decisionChannel.enum.assignment} AND d.field LIKE 'review:%' AND d.kind=${decisionKind.enum.set}
)`;
const emailReviewsFrom = sql`${emailReviewsSql} "EmailReview"`;
export const emailReviewsRead = new QueryBuilder()
  .select(decisionProjectionColumns(emailReview))
  .from(emailReviewsFrom)
  .as("EmailReview");
export const emailReviewsReadFields = emailReviewsRead._.selectedFields;

/** Reviewed account facts are durable decisions, separate from current settlement. */
export const emailFinancialAssociationsSql = sql`(
 SELECT d.id, substring(d.subject from 7)::uuid AS "emailId", r.*, d."actorId" AS "decidedByUserId", d.at AS "createdAt"
 FROM "Decision" d CROSS JOIN LATERAL jsonb_to_record(
   CASE WHEN jsonb_typeof(d.value)='object' THEN d.value ELSE '{}'::jsonb END
 ) AS r("evidenceChecksum" text,"transactionId" uuid,"reviewedAccountId" uuid,"sourceAccountLabel" text,"reviewReason" text)
 WHERE d.channel=${decisionChannel.enum.assignment} AND d.field LIKE 'financial:%' AND d.kind=${decisionKind.enum.set} AND d.subject LIKE 'email:%'
)`;
const emailFinancialAssociationsFrom = sql`${emailFinancialAssociationsSql} "EmailFinancialAssociation"`;
export const emailFinancialAssociationsRead = new QueryBuilder()
  .select(decisionProjectionColumns(emailFinancialAssociation))
  .from(emailFinancialAssociationsFrom)
  .as("EmailFinancialAssociation");
export const emailFinancialAssociationsReadFields =
  emailFinancialAssociationsRead._.selectedFields;

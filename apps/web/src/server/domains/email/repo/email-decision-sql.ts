import { emailLinkEvidenceKind } from "@cubby/schemas/email-fields";
import { entitySchema } from "@cubby/schemas/entity";
import {
  decisionChannel,
  decisionKind,
  decisionActorKind,
} from "@cubby/schemas/kernel/stage";
import { feedbackAuthority } from "@cubby/schemas/suggestion";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  emailReview,
  emailPurchaseDecision,
  emailFinancialAssociation,
} from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { decisionProjectionColumns } from "~/server/domains/email/repo/decision-projection";

/** Decisions retain UUIDs or public codes; reads resolve the same identity as the kernel. */
const purchaseReference = (identity: SQLWrapper, value: SQL) => sql`
  ${identity}.kind=${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)}
  AND ((${identity}.id=CASE WHEN pg_input_is_valid(lower(${value}), pg_typeof(NULL::uuid)::text)
    THEN lower(${value})::uuid END AND ${identity}.id::text=lower(${value}))
    OR ${identity}.shortcode=upper(btrim(${value})))`;

/** Email subjects with a link decision naming one of `events`' order events. */
const subjectsLinkingEvents = (events: SQL) => sql`
    SELECT link.subject FROM ${events}
    JOIN LATERAL (
      SELECT link.subject FROM "Decision" link
      WHERE link.field LIKE 'link:%' AND link.value->>'eventId'=event.id::text
        AND link.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
        AND link.subject LIKE 'email:%'
      OFFSET 0
    ) link ON true`;

type LinkSubjects =
  | { purchaseIds: SQL }
  | { emailIds: SQL }
  | { emailSubject: SQL }
  | { orderMailId: SQL };

/**
 * Current member links projected from decision slots, including their original
 * evidence. A subject-scoped projection reads only the scoped subjects' slots
 * and their event pointers; the unscoped one sorts and self-joins every Email
 * decision. A batch of Emails, or an original, also reads links that name its
 * order events. A point read needs only the Email's own slots and their event
 * pointers. Every row depends only on its own subject's slots and the event
 * pointers of its events, so a scoped read returns exactly the unscoped rows
 * for the subjects it names.
 */
const emailLinkDecisionProjection = (
  correlateEventPointers: boolean,
  subjects?: LinkSubjects,
) => sql`(
  WITH ${
    subjects
      ? sql`
  ${
    "purchaseIds" in subjects
      ? sql`requested_link_targets AS MATERIALIZED (
          ${subjects.purchaseIds}
        ), link_targets AS (
          SELECT id FROM requested_link_targets
          UNION ALL
          SELECT redirect.id FROM requested_link_targets requested
          JOIN "Entity" redirect ON redirect."mergedIntoId" = requested.id
        ),`
      : sql``
  }
  link_subjects AS MATERIALIZED (${
    "emailSubject" in subjects
      ? sql`SELECT ${subjects.emailSubject} AS subject`
      : "emailIds" in subjects
        ? sql`
    SELECT 'email:'||scoped.id AS subject FROM unnest(${subjects.emailIds}) AS scoped(id)
    UNION
    ${subjectsLinkingEvents(sql`"Email" scoped JOIN "OrderMailEvent" event ON event."orderMailId"=scoped."orderMailId"`)}
    WHERE scoped.id IN (SELECT ids.id FROM unnest(${subjects.emailIds}) AS ids(id))`
        : "orderMailId" in subjects
          ? sql`
    SELECT 'email:'||scoped.id AS subject FROM "Email" scoped WHERE scoped."orderMailId"=${subjects.orderMailId}
    UNION
    ${subjectsLinkingEvents(sql`"OrderMailEvent" event`)}
    WHERE event."orderMailId"=${subjects.orderMailId}`
          : sql`
    SELECT DISTINCT link.subject
    FROM link_targets target
    JOIN "Decision" link ON
      (CASE WHEN link.field LIKE 'link:%' THEN substring(link.field from 6)::uuid END) = target.id
    WHERE link.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
      AND link.subject LIKE 'email:%' AND link.field LIKE 'link:%'`
  }
  ),
  relevant_subjects AS MATERIALIZED (
    SELECT subject FROM link_subjects
    UNION
    SELECT 'emailEvent:'||event.id FROM link_subjects link
    JOIN "Email" email ON email.id=substring(link.subject from 7)::uuid
    JOIN "OrderMailEvent" event ON event."orderMailId"=email."orderMailId"
    UNION
    SELECT 'emailEvent:'||(d.value->>'eventId') FROM "Decision" d
    JOIN link_subjects link ON link.subject=d.subject
    WHERE d.field LIKE 'link:%' AND d.value->>'eventId' IS NOT NULL
  ),
  `
      : sql``
  }current AS (
    ${
      subjects
        ? sql`
    SELECT latest.* FROM relevant_subjects relevant CROSS JOIN LATERAL (
      SELECT DISTINCT ON (slot) * FROM "Decision"
      WHERE subject=relevant.subject AND channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
      ORDER BY slot, at DESC, id DESC
    ) latest`
        : sql`
    SELECT DISTINCT ON (subject, slot) * FROM "Decision"
    WHERE channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
      AND (subject LIKE 'email:%' OR subject LIKE 'emailEvent:%')
    ORDER BY subject, slot, at DESC, id DESC`
    }
  ) SELECT DISTINCT ON (d.subject, coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid), coalesce(linked_event.id,(d.value->>'eventId')::uuid))
    d.id, coalesce(linked_event.id,(d.value->>'eventId')::uuid) AS "eventId",
    coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid) AS "purchaseId",
    d.value->>${"decision"} AS decision,
    d.value->>'evidenceChecksum' AS "evidenceChecksum", d."actorId" AS "decidedByUserId",
    d.value->>'proposedBy' AS "proposedBy", coalesce(d.value->>${"authority"}, CASE WHEN d."actorKind"=${sqlEnumConstant(decisionActorKind, decisionActorKind.enum.member)} THEN ${sqlEnumConstant(feedbackAuthority, feedbackAuthority.enum.member)} ELSE ${sqlEnumConstant(feedbackAuthority, feedbackAuthority.enum.automatic)} END) AS authority,
    coalesce(review.value #>> '{}',${"resolved"}) AS status,
    ((d.value->>${"active"})::boolean IS DISTINCT FROM false AND
      live_purchase.id IS NOT NULL AND live_email.id IS NOT NULL AND
      (d."actorKind"=${sqlEnumConstant(decisionActorKind, decisionActorKind.enum.member)} OR
        coalesce(linked_event.id,(d.value->>'eventId')::uuid) IS NULL OR
        (active_event.id IS NOT NULL AND active_event."supersededAt" IS NULL)) AND
      (d.value->>${"decision"}=${sqlEnumConstant(emailLinkEvidenceKind, emailLinkEvidenceKind.enum.dismissed)} OR
        coalesce(event_target."mergedIntoId",event_target.id,pointer_target."mergedIntoId",pointer_target.id) = live_purchase.id)) AS active,
    live_email.id AS "emailId", (d.value->>'originalId')::uuid AS "originalId",
    d.value->'producer' AS producer, d.at AS "createdAt", d.at AS "updatedAt"
  FROM current d LEFT JOIN current pointer ON pointer.subject=d.subject AND pointer.field='purchaseId'
  LEFT JOIN "Entity" target ON target.id=substring(d.field from 6)::uuid
  LEFT JOIN "Email" live_email ON live_email.id=substring(d.subject from 7)::uuid AND ${notDeleted("live_email")}
  LEFT JOIN "OrderMailEvent" linked_event ON linked_event."orderMailId"=live_email."orderMailId"
    AND d.value->>${"decision"}=${sqlEnumConstant(emailLinkEvidenceKind, emailLinkEvidenceKind.enum.linked)}
    AND EXISTS (SELECT 1 FROM current ep JOIN "Entity" ep_target ON ${purchaseReference(sql.identifier("ep_target"), sql`ep.value#>>'{}'`)}
      WHERE ep.subject='emailEvent:' || linked_event.id AND ep.field='purchaseId' AND ep.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
      AND coalesce(ep_target."mergedIntoId",ep_target.id)=coalesce(target."mergedIntoId",target.id)
      -- Resolve pointers only for the candidate event. Flattening this subquery
      -- makes PostgreSQL resolve every event pointer before filtering.
      ${correlateEventPointers ? sql`OFFSET 0` : sql``})
  LEFT JOIN current event_pointer ON event_pointer.subject='emailEvent:' || coalesce(linked_event.id::text,d.value->>'eventId') AND event_pointer.field='purchaseId'
  LEFT JOIN "OrderMailEvent" active_event ON active_event.id=coalesce(linked_event.id,(d.value->>'eventId')::uuid)
    AND active_event."orderMailId"=live_email."orderMailId"
  LEFT JOIN "Entity" pointer_target ON ${purchaseReference(sql.identifier("pointer_target"), sql`pointer.value#>>'{}'`)} AND pointer.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
  LEFT JOIN "Entity" event_target ON ${purchaseReference(sql.identifier("event_target"), sql`event_pointer.value#>>'{}'`)} AND event_pointer.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
  LEFT JOIN "Purchase" live_purchase ON live_purchase.id=coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid) AND ${notDeleted("live_purchase")}
  LEFT JOIN current review ON review.subject=d.subject AND review.field='review-status:' || d.id
  WHERE d.subject LIKE 'email:%' AND d.field LIKE 'link:%'
    ${subjects && "emailSubject" in subjects ? sql`AND d.subject=${subjects.emailSubject}` : sql``}
    ${subjects && "purchaseIds" in subjects ? sql`AND coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid) IN (${subjects.purchaseIds})` : sql``}
    AND d.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
  ORDER BY d.subject, coalesce(target."mergedIntoId",target.id,substring(d.field from 6)::uuid), coalesce(linked_event.id,(d.value->>'eventId')::uuid), active DESC,
    (d.value->>${"decision"}=${sqlEnumConstant(emailLinkEvidenceKind, emailLinkEvidenceKind.enum.linked)}) DESC,
    (substring(d.field from 6)::uuid=coalesce(target."mergedIntoId",target.id)) DESC,d.id
 )`;
export const emailLinkDecisionsSql = emailLinkDecisionProjection(false);
/** One Email's links; correlated per row, it reads only that Email's subjects. */
export const emailLinkDecisionsForEmailSql = (emailId: SQL) =>
  emailLinkDecisionProjection(true, {
    emailSubject: sql`'email:'||${emailId}`,
  });
/**
 * The links of the Email that owns one link decision, found by its primary key.
 * Filter by the decision id: the projection holds that Email's other links too.
 */
const emailLinkDecisionsForDecisionSql = (decisionId: SQL) =>
  emailLinkDecisionProjection(true, {
    emailSubject: sql`(SELECT decided.subject FROM "Decision" decided
      WHERE decided.id=${decisionId} AND decided.subject LIKE 'email:%')`,
  });
export const emailLinkDecisionsForPurchasesSql = (purchaseIds: SQL) =>
  emailLinkDecisionProjection(true, { purchaseIds });
/** Current links for a uuid[] of Emails, without projecting the household's. */
export const emailLinkDecisionsForEmailsSql = (emailIds: SQL) =>
  emailLinkDecisionProjection(true, { emailIds });
const decisionsRead = (projection: SQL) =>
  new QueryBuilder()
    .select(decisionProjectionColumns(emailPurchaseDecision))
    .from(sql`${projection} "EmailPurchaseDecision"`)
    .as("EmailPurchaseDecision");
/** Every link in the household; only reads that need all of them use it. */
export const emailLinkDecisionsRead = decisionsRead(emailLinkDecisionsSql);
export const emailLinkDecisionsReadForEmails = (emailIds: SQL) =>
  decisionsRead(emailLinkDecisionsForEmailsSql(emailIds));
export const emailLinkDecisionsReadForEmail = (emailId: SQL) =>
  decisionsRead(emailLinkDecisionsForEmailSql(emailId));
/** Includes the owning Email's other links; filter by the decision id. */
export const emailLinkDecisionsReadForDecision = (decisionId: SQL) =>
  decisionsRead(emailLinkDecisionsForDecisionSql(decisionId));
/** Every link whose event belongs to one original, from any Email subject. */
export const emailLinkDecisionsReadForOrderMail = (orderMailId: SQL) =>
  decisionsRead(emailLinkDecisionProjection(true, { orderMailId }));

/**
 * Every retained link receipt remains gradeable after its current slot changes.
 * A point read by decision id projects only that decision's Email for `active`.
 */
const emailLinkDecisionHistoryProjection = (decisionId?: SQL) => sql`(
  SELECT d.id, (d.value->>'eventId')::uuid AS "eventId",
    coalesce(history_target."mergedIntoId",history_target.id,(substring(d.field from 6))::uuid) AS "purchaseId", d.value->>${"decision"} AS decision,
    d.value->>'evidenceChecksum' AS "evidenceChecksum", d."actorId" AS "decidedByUserId",
    d.value->>'proposedBy' AS "proposedBy",
    coalesce(d.value->>${"authority"}, CASE WHEN d."actorKind"=${sqlEnumConstant(decisionActorKind, decisionActorKind.enum.member)} THEN ${sqlEnumConstant(feedbackAuthority, feedbackAuthority.enum.member)} ELSE ${sqlEnumConstant(feedbackAuthority, feedbackAuthority.enum.automatic)} END) AS authority,
    coalesce((SELECT status.value#>>'{}' FROM "Decision" status WHERE status.subject=d.subject
      AND status.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND status.field='review-status:'||d.id
      ORDER BY status.at DESC,status.id DESC LIMIT 1),d.value->>${"status"},${"resolved"}) AS status,
    EXISTS (SELECT 1 FROM ${decisionId ? emailLinkDecisionsForDecisionSql(decisionId) : emailLinkDecisionsSql} live WHERE live.id=d.id AND live.active) AS active,
    owner.id AS "emailId", (d.value->>'originalId')::uuid AS "originalId",
    d.value->'producer' AS producer, d.at AS "createdAt",d.at AS "updatedAt"
  FROM "Decision" d LEFT JOIN "Entity" history_target ON history_target.id=CASE WHEN d.field LIKE 'link:%' THEN substring(d.field from 6)::uuid END
  LEFT JOIN "Email" owner ON owner.id=CASE WHEN d.subject LIKE 'email:%' THEN substring(d.subject from 7)::uuid END AND ${notDeleted("owner")}
  WHERE d.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND d.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
    AND d.field LIKE 'link:%' AND (d.subject LIKE 'email:%' OR d.subject LIKE 'mailOriginal:%')
    ${decisionId ? sql`AND d.id=${decisionId}` : sql``}
)`;
/** Every automatic receipt for the review list; `active` projects every link once. */
export const emailLinkDecisionHistorySql = emailLinkDecisionHistoryProjection();
/** One receipt by id, whichever subject retains it. */
export const emailLinkDecisionHistoryReadForDecision = (decisionId: SQL) =>
  new QueryBuilder()
    .select(decisionProjectionColumns(emailPurchaseDecision))
    .from(
      sql`${emailLinkDecisionHistoryProjection(decisionId)} "EmailPurchaseDecision"`,
    )
    .as("EmailPurchaseDecision");

const emailReviewProjection = (subjectScope?: SQL) => sql`(
  SELECT d.id, d.at AS "createdAt", r.*
  FROM "Decision" d CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(d.value)='object' THEN d.value ELSE '{}'::jsonb END) AS r(
    family text, "subjectId" uuid, "emailId" uuid, "originalId" uuid,
    checksum text, classification text, "operationId" text, verdict text,
    correction jsonb, reason text, evidence jsonb, intent text, authority text,
    "actorUserId" text, subject jsonb, receipt jsonb, metadata jsonb)
  WHERE d.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND d.field LIKE 'review:%' AND d.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)}
    ${subjectScope ? sql`AND ${subjectScope}` : sql``}
)`;
/** Decision history projected with the review contract; retained tables are not read. */
export const emailReviewsSql = emailReviewProjection();
/** Both authored and carried reviews with an Email id use its Email subject. */
export const emailReviewsForEmailSql = (emailId: SQL) =>
  emailReviewProjection(
    sql`d.subject='email:'||${emailId} AND r."emailId"=${emailId}`,
  );

/** The original's review history can hold intent before it is attached to an Email. */
export const emailReviewsForIntentSql = (emailId: SQL, originalId: SQL) =>
  emailReviewProjection(
    sql`d.subject IN ('email:'||${emailId}, 'mailOriginal:'||${originalId})`,
  );
const emailReviewsFrom = sql`${emailReviewsSql} "EmailReview"`;
export const emailReviewsRead = new QueryBuilder()
  .select(decisionProjectionColumns(emailReview))
  .from(emailReviewsFrom)
  .as("EmailReview");
export const emailReviewsReadFields = emailReviewsRead._.selectedFields;

const emailFinancialAssociationProjection = (emailId?: SQL) => sql`(
 SELECT d.id, substring(d.subject from 7)::uuid AS "emailId", r.*, d."actorId" AS "decidedByUserId", d.at AS "createdAt"
 FROM "Decision" d CROSS JOIN LATERAL jsonb_to_record(
   CASE WHEN jsonb_typeof(d.value)='object' THEN d.value ELSE '{}'::jsonb END
 ) AS r("evidenceChecksum" text,"transactionId" uuid,"reviewedAccountId" uuid,"sourceAccountLabel" text,"reviewReason" text)
 WHERE d.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)} AND d.field LIKE 'financial:%' AND d.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)} AND d.subject LIKE 'email:%'
   ${emailId ? sql`AND d.subject='email:'||${emailId}` : sql``}
)`;
/** Reviewed account facts are durable decisions, separate from current settlement. */
export const emailFinancialAssociationsSql =
  emailFinancialAssociationProjection();
export const emailFinancialAssociationsForEmailSql = (emailId: SQL) =>
  emailFinancialAssociationProjection(emailId);
const emailFinancialAssociationsFrom = sql`${emailFinancialAssociationsSql} "EmailFinancialAssociation"`;
export const emailFinancialAssociationsRead = new QueryBuilder()
  .select(decisionProjectionColumns(emailFinancialAssociation))
  .from(emailFinancialAssociationsFrom)
  .as("EmailFinancialAssociation");
export const emailFinancialAssociationsReadFields =
  emailFinancialAssociationsRead._.selectedFields;

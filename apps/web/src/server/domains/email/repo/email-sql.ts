import {
  feedbackAuthority,
  assessmentFamily,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
import { emailPurchaseLinkState } from "@cubby/schemas/email-fields";
import {
  mailboxClassificationStage,
  mailboxClassification,
  type MailboxClassification,
} from "@cubby/schemas/mailbox-research";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { and, sql, type SQL } from "drizzle-orm";

import { uuidArrayParam } from "~/server/db/helpers/query";

// Leaf module: data-quality bindings import these predicates, and the Email
// repository imports the list scaffold that imports those bindings.

const { rule, decision, model, resolution } = mailboxClassificationStage.enum;

/** Bulk and record checks read database-maintained presence, never retained bodies. */
export const emailRetainedContentSql = (
  email: SQL = sql`"Email"`,
  original?: SQL,
) => sql<boolean>`(
  ${email}."orderMailId" IS NOT NULL AND ${email}."contentClearedAt" IS NULL AND (
    ${
      original
        ? sql`(${original}.id IS NOT NULL AND ${original}."hasRetainedText")`
        : sql`EXISTS (SELECT 1 FROM "OrderMail" original
          WHERE original.id=${email}."orderMailId"
            AND original."hasRetainedText")`
    }
    OR EXISTS (SELECT 1 FROM "OrderMailAttachment" attachment
      WHERE attachment."orderMailId"=${email}."orderMailId"
        AND (attachment."pendingObjectKey" IS NOT NULL OR attachment."imageId" IS NOT NULL))
  )
)`;
/** Assessment subjects own observation lineage; caller metadata is not a second join key. */
export const emailFeedbackObservationIdSql = (label: SQL) => sql<
  string | null
>`(
 SELECT a.subject->>'observationId' FROM "Assessment" a
 WHERE a.id = ${label}."assessmentId" AND a.family = ${assessmentFamily.enum.email_relevance}
)`;
/** A supplied Assessment alias must already join this Feedback by id and
 * restrict its family to email_relevance. */
export const emailFeedbackClassificationSql = (
  label: SQL,
  assessment?: SQL,
) => sql<MailboxClassification | null>`
 CASE WHEN ${label}.correction @> ${JSON.stringify({ present: true })}::jsonb THEN ${label}.correction->>'value'
 WHEN ${label}.verdict = ${feedbackVerdict.enum.correct} THEN ${
   assessment
     ? sql`${assessment}.judgment->>'classification'`
     : sql`(SELECT a.judgment->>'classification' FROM "Assessment" a
     WHERE a.id = ${label}."assessmentId" AND a.family = ${assessmentFamily.enum.email_relevance})`
 } END`;
export const emailFeedbackHasClassificationSql = (
  label: SQL,
  assessment?: SQL,
) => sql`
 (${emailFeedbackClassificationSql(label, assessment)}) IN (${mailboxClassification.enum.related},${mailboxClassification.enum.unrelated},${mailboxClassification.enum.uncertain})`;
/** The stages a member's review can disagree with. */
export const automatedStagesSql = sql`(${rule}, ${decision}, ${model})`;

/**
 * Correlated to the plain Email root table used by the list scaffold. Explicit
 * qualification prevents Drizzle's single-table SELECT from turning the inner
 * identity comparison into a self-comparison. Thread context is not a link.
 * Accepted Orders on any member of the canonical source family survive cache
 * disposal and historical aliases; active lifecycle decisions remain separate.
 */
export const emailAcceptedEvidenceSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
  SELECT accepted."id" AS "sourceOrderId", p."id" AS "purchaseId", accepted."checksum" AS "evidenceChecksum", accepted."createdAt" AS "acceptedAt",
    -- The accepted bytes differ from the current original: the Email's own
    -- checksum for a message source, the attachment's for an attachment.
    accepted."checksum" IS DISTINCT FROM (CASE
      WHEN identity."kind" = ${importSourceKind.enum.mail_message} THEN "Email"."checksum"
      ELSE (
        SELECT current_attachment."checksum" FROM "OrderMailAttachment" current_attachment
        WHERE current_attachment."orderMailId" = "Email"."orderMailId"
          AND identity."externalKey" = "Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId" || ':attachment:' || current_attachment."providerAttachmentId"
      )
    END) AS "changed"
  FROM "ImportSourceClaim" identity
  INNER JOIN "ImportSourceClaim" root
    ON root."id" = coalesce(identity."canonicalClaimId", identity."id")
    AND root."canonicalClaimId" IS NULL
    AND root."ledgerPartyId" = identity."ledgerPartyId"
    AND root."kind" = identity."kind"
  INNER JOIN "ImportSourceClaim" family
    -- A root has no parent: its own id and its aliases use separate indexes.
    ON (family."id" = root."id" OR family."canonicalClaimId" = root."id")
    AND family."ledgerPartyId" = root."ledgerPartyId"
    AND family."kind" = root."kind"
  INNER JOIN "ImportSourceOrder" accepted ON accepted."sourceClaimId" = family."id"
  ${
    includeDeleted
      ? // A deleted Purchase's detached association names it only through
        // its accepted observation, which keeps the original subject; an
        // association accepted before observations existed reads as unknown.
        sql`LEFT JOIN "SourceOrderObservation" observation
    ON accepted."purchaseId" IS NULL AND observation."id" = accepted."acceptedObservationId"
  LEFT JOIN "Purchase" p ON p."id" = coalesce(accepted."purchaseId", observation."purchaseId")`
      : sql`INNER JOIN "Purchase" p ON p."id" = accepted."purchaseId" AND p."deletedAt" IS NULL`
  }
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE identity."ledgerPartyId" = "Email"."ledgerPartyId"
    AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")` : sql`true`}
    AND (
      (identity."kind" = ${importSourceKind.enum.mail_message}
        AND identity."externalKey" = "Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId")
      OR (identity."kind" = ${importSourceKind.enum.mail_attachment} AND EXISTS (
        SELECT 1 FROM "OrderMailAttachment" attachment
        INNER JOIN "OrderMail" original ON original."id" = attachment."orderMailId"
        WHERE original."id" = "Email"."orderMailId"
          AND original."ledgerPartyId" = "Email"."ledgerPartyId"
          AND identity."externalKey" = "Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId" || ':attachment:' || attachment."providerAttachmentId"
      ))
    )
`;

/** Purchases an active order event of the Email is linked to by review. */
const emailLinkedDecisionPurchasesSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
  SELECT decision."purchaseId"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "AssessmentEmailLink" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND ${includeDeleted ? sql`true` : sql`p."deletedAt" IS NULL`}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL AND decision."decision" = ${emailPurchaseLinkState.enum.linked}
    AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")` : sql`true`}
`;

/** Accepted families and explicit lifecycle decisions share one association policy. */
export const emailPurchaseAssociationsSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
  SELECT evidence."purchaseId" FROM (${emailAcceptedEvidenceSql(includeDeleted, accountOwnerScope)}) evidence
  UNION ${emailLinkedDecisionPurchasesSql(includeDeleted, accountOwnerScope)}
`;

/**
 * Inverse association read. The candidate set is deliberately permissive;
 * the existing association policy alone decides acceptance. Materializing
 * purchase identities before the Email join prevents a mailbox × claims join;
 * materializing eligible metadata keeps the final policy off the entire mailbox.
 */
export const purchaseAssociatedEmailsSql = (purchaseId: SQL): SQL => sql`
  WITH accepted_roots AS MATERIALIZED (
    SELECT DISTINCT coalesce(family."canonicalClaimId", family."id") AS id
    FROM "ImportSourceOrder" accepted
    JOIN "ImportSourceClaim" family ON family."id" = accepted."sourceClaimId"
    WHERE accepted."purchaseId" = ${purchaseId}
  ), accepted_identities AS MATERIALIZED (
    -- The claims whose coalesce(canonicalClaimId, id) is a root, split so
    -- each arm reads an index rather than every claim.
    SELECT identity."ledgerPartyId", identity."kind", identity."externalKey"
    FROM accepted_roots root
    JOIN "ImportSourceClaim" identity ON identity."id" = root.id AND identity."canonicalClaimId" IS NULL
    UNION
    SELECT identity."ledgerPartyId", identity."kind", identity."externalKey"
    FROM accepted_roots root
    JOIN "ImportSourceClaim" identity ON identity."canonicalClaimId" = root.id
  ), candidate_ids AS (
    SELECT candidate."id"
    FROM accepted_identities identity
    JOIN "Email" candidate ON candidate."deletedAt" IS NULL
      AND candidate."ledgerPartyId" = identity."ledgerPartyId"
      -- Separate arms: the message key matches "Email_source_key_idx".
      AND identity."kind" = ${importSourceKind.enum.mail_message}
      AND identity."externalKey" = candidate."provider" || ':' || candidate."mailboxId" || ':' || candidate."messageId"
    UNION
    SELECT candidate."id"
    FROM accepted_identities identity
    JOIN "Email" candidate ON candidate."deletedAt" IS NULL
      AND candidate."ledgerPartyId" = identity."ledgerPartyId"
      AND identity."kind" = ${importSourceKind.enum.mail_attachment}
      AND starts_with(identity."externalKey", candidate."provider" || ':' || candidate."mailboxId" || ':' || candidate."messageId" || ':attachment:')
    UNION
    SELECT candidate."id"
    FROM "AssessmentEmailLink" decision
    JOIN "OrderMailEvent" event ON event."id" = decision."eventId"
    JOIN "Email" candidate ON candidate."orderMailId" = event."orderMailId" AND candidate."deletedAt" IS NULL
    WHERE decision."purchaseId" = ${purchaseId}
  ), eligible AS MATERIALIZED (
    SELECT candidate."id", candidate."shortcode", candidate."subject", candidate."deletedAt",
      candidate."ledgerPartyId", candidate."provider", candidate."mailboxId", candidate."messageId",
      candidate."orderMailId", candidate."checksum"
    FROM candidate_ids ids JOIN "Email" candidate ON candidate."id" = ids."id" AND candidate."deletedAt" IS NULL
  )
  SELECT "Email".* FROM eligible "Email"
  WHERE EXISTS (SELECT 1 FROM (${emailPurchaseAssociationsSql()}) association
    WHERE association."purchaseId" = ${purchaseId})
`;

const emailSourceKeySql = sql`"Email"."provider" || ':' || "Email"."mailboxId" || ':' || "Email"."messageId"`;

/**
 * `("purchaseId", "ledgerPartyId")` for each mailbox whose live Email
 * `emailPurchaseAssociationsSql` associates with a live purchase of
 * `purchases` (a relation with `id` and `"deletedAt"`), account owner scope
 * ignored. The same policy read from the purchase side as plain joins, so a
 * whole set of purchases resolves in one pass and one purchase through its
 * indexes.
 */
export const purchaseMailPartiesSql = (purchases: SQL): SQL => {
  // Inline subqueries, not CTEs: their row estimates let a whole set of
  // purchases hash-join "Email" instead of probing it once per claim.
  const roots = sql`
    SELECT DISTINCT accepted."purchaseId", root."id", root."ledgerPartyId", root."kind", root."externalKey"
    FROM (${purchases}) purchase
    JOIN "ImportSourceOrder" accepted ON accepted."purchaseId" = purchase."id"
    JOIN "ImportSourceClaim" family ON family."id" = accepted."sourceClaimId"
    JOIN "ImportSourceClaim" root ON root."id" = coalesce(family."canonicalClaimId", family."id")
      AND root."canonicalClaimId" IS NULL
      AND root."ledgerPartyId" = family."ledgerPartyId" AND root."kind" = family."kind"
    WHERE purchase."deletedAt" IS NULL`;
  const identities = sql`(
    SELECT "purchaseId", "ledgerPartyId", "kind", "externalKey" FROM (${roots}) roots
    UNION ALL
    SELECT roots."purchaseId", alias."ledgerPartyId", alias."kind", alias."externalKey"
    FROM (${roots}) roots JOIN "ImportSourceClaim" alias ON alias."canonicalClaimId" = roots."id"
      AND alias."ledgerPartyId" = roots."ledgerPartyId" AND alias."kind" = roots."kind"
  )`;
  return sql`
  SELECT identity."purchaseId", identity."ledgerPartyId"
  FROM ${identities} identity
  JOIN "Email" ON "Email"."deletedAt" IS NULL
    AND "Email"."ledgerPartyId" = identity."ledgerPartyId"
    AND identity."kind" = ${importSourceKind.enum.mail_message}
    AND ${emailSourceKeySql} = identity."externalKey"
  UNION
  SELECT identity."purchaseId", identity."ledgerPartyId"
  FROM ${identities} identity
  -- The message key ahead of ":attachment:" under the mail source key grammar
  -- (parseMailSourceKey: the message id holds no colon) reaches
  -- "Email_source_key_idx"; the attachment then matches exactly.
  JOIN "Email" ON "Email"."deletedAt" IS NULL
    AND "Email"."ledgerPartyId" = identity."ledgerPartyId"
    AND identity."kind" = ${importSourceKind.enum.mail_attachment}
    AND ${emailSourceKeySql} = substring(identity."externalKey" from '^(.+?:[^:]+):attachment:')
  JOIN "OrderMail" original ON original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
  JOIN "OrderMailAttachment" attachment ON attachment."orderMailId" = original."id"
    AND identity."externalKey" = ${emailSourceKeySql} || ':attachment:' || attachment."providerAttachmentId"
  UNION
  SELECT decision."purchaseId", "Email"."ledgerPartyId"
  FROM (${purchases}) purchase
  -- The purchase's decisions by "AssessmentState_email_purchase_uuid_idx",
  -- then the linked state by id: a "decision" predicate beside the purchase
  -- lets the planner full-scan the linked-event partial index instead.
  JOIN "AssessmentEmailLink" decision ON decision."purchaseId" = purchase."id"
  JOIN "AssessmentEmailLink" linked ON linked."id" = decision."id"
    AND linked."decision" = ${emailPurchaseLinkState.enum.linked}
  JOIN "OrderMailEvent" event ON event."id" = decision."eventId" AND event."supersededAt" IS NULL
  JOIN "OrderMail" original ON original."id" = event."orderMailId"
  JOIN "Email" ON "Email"."orderMailId" = original."id"
    AND "Email"."ledgerPartyId" = original."ledgerPartyId" AND "Email"."deletedAt" IS NULL
  WHERE purchase."deletedAt" IS NULL
`;
};

/**
 * The member's own Relevance for the current original: a resolution, else the
 * owner's latest independent review label on a prediction of this checksum.
 */
const memberClassificationWithResolutionSql = (email: SQL, reviewed: SQL) =>
  sql<MailboxClassification | null>`CASE
    WHEN ${email}."classificationStage" = ${resolution} THEN ${email}.classification
    ELSE ${reviewed} END`;

// Keep ownership/checksum/latest-valid policy aligned with emailMemberReviewReadSql;
// email-review-quality.integration.test.ts compares their returned values.
export const emailMemberClassificationSql = () =>
  memberClassificationWithResolutionSql(
    sql`"Email"`,
    sql`(
    SELECT ${emailFeedbackClassificationSql(sql`label`)}
    FROM "Feedback" label
    INNER JOIN "EmailClassificationObservation" prediction ON prediction."id"::text = ${emailFeedbackObservationIdSql(sql`label`)}
    INNER JOIN "LedgerParty" owner ON owner."id" = "Email"."ledgerPartyId"
    WHERE prediction."emailId" = "Email"."id"
      AND prediction."checksum" = "Email"."checksum"
      AND label."actorUserId" = owner."userId" AND label.authority = ${feedbackAuthority.enum.member}
      AND ${emailFeedbackHasClassificationSql(sql`label`)}
    ORDER BY label."createdAt" DESC, label."id" DESC
    LIMIT 1
  )`,
  );
/** The latest rule, decision-model or relevance-model result for the current original. */
const emailAutomatedClassificationSql = () => sql`
  COALESCE(
    (SELECT prediction."classification"
      FROM "EmailClassificationObservation" prediction
      WHERE prediction."emailId" = "Email"."id"
        AND prediction."checksum" = "Email"."checksum"
        AND prediction."stage" IN ${automatedStagesSql}
      ORDER BY prediction."createdAt" DESC, prediction."id" DESC
      LIMIT 1),
    CASE WHEN "Email"."classificationStage" IN ${automatedStagesSql} THEN "Email"."classification" END
  )
`;
/** One definition owns the review-conflict filter, its hydrated flag and conflict recording. */
export const emailReviewConflictSql = () => sql<boolean>`
  COALESCE((${emailMemberClassificationSql()}) <> (${emailAutomatedClassificationSql()}), false)
`;

/** The same SQL owns filter/count membership and the hydrated linked value. */
export const emailLinkedSql = () =>
  // Existence does not need the complete, deduplicated association list.
  sql<boolean>`(EXISTS (${emailAcceptedEvidenceSql()})
    OR EXISTS (${emailLinkedDecisionPurchasesSql()}))`;

/** Resolve immutable Feedback lineage once before the mailbox join. Without
 * this boundary, join reordering can repeat the Assessment lookup for every
 * Email × Feedback pair, even though each review names one Assessment.
 * Page IDs constrain the prediction join; bounded hydration still resolves
 * immutable Feedback lineage once, outside that join. Keep policy aligned with
 * emailMemberClassificationSql; email-review-quality.integration.test.ts pins parity. */
const emailMemberReviewReadSql = (ids?: SQL) => sql`
  WITH eligible_feedback AS MATERIALIZED (
    SELECT label.id, label."createdAt", label."actorUserId",
      reviewed_assessment.subject->>'observationId' AS "observationId",
      ${emailFeedbackClassificationSql(sql`label`, sql`reviewed_assessment`)} AS classification
    FROM "Feedback" label
    JOIN "Assessment" reviewed_assessment
      ON reviewed_assessment.id = label."assessmentId"
      AND reviewed_assessment.family = ${assessmentFamily.enum.email_relevance}
    WHERE label.authority = ${feedbackAuthority.enum.member}
      AND ${emailFeedbackHasClassificationSql(sql`label`, sql`reviewed_assessment`)}
  )
  SELECT DISTINCT ON (candidate.id) candidate.id AS "entityId", label.classification
  FROM "Email" candidate
  JOIN "EmailClassificationObservation" prediction
    ON prediction."emailId" = candidate.id AND prediction.checksum = candidate.checksum
  JOIN eligible_feedback label ON label."observationId" = prediction.id::text
  JOIN "LedgerParty" owner ON owner.id = candidate."ledgerPartyId"
    AND owner."userId" = label."actorUserId"
  ${ids ? sql`WHERE candidate.id = ANY(${uuidArrayParam(ids)})` : sql``}
  ORDER BY candidate.id, label."createdAt" DESC, label.id DESC
`;

/** One row per Email: ordinary joins can spill instead of degrading a hashed
 * SubPlan into a source-list scan for every Email. Deduplication prevents
 * repeated imports or duplicate sources from multiplying Email rows. */
const emailQualityRead = (ids?: SQL, predicate?: SQL) => {
  const condition = and(
    ids ? sql`candidate.id = ANY(${uuidArrayParam(ids)})` : undefined,
    predicate,
  );
  return sql`
  SELECT candidate.id AS "entityId", membership."ledgerPartyId" IS NOT NULL AS "completedImport",
    ${emailRetainedContentSql(sql`candidate`, sql`quality_original`)} AS "retainedContent",
    ${memberClassificationWithResolutionSql(sql`candidate`, sql`member_review.classification`)} AS "memberClassification",
    linked_state.linked AS "linked"
  FROM "Email" candidate
  -- One evaluation per related Email for both checks that read it; the helper
  -- binds the unaliased "Email" root, which this lateral names for the same row.
  LEFT JOIN LATERAL (
    SELECT ${emailLinkedSql()} AS linked FROM "Email"
    WHERE "Email".id = candidate.id AND "Email".classification = ${mailboxClassification.enum.related}
  ) linked_state ON true
  LEFT JOIN "OrderMail" quality_original ON quality_original.id=candidate."orderMailId"
  LEFT JOIN (${emailMemberReviewReadSql(ids)}) member_review ON member_review."entityId" = candidate.id
  LEFT JOIN (
    SELECT DISTINCT import."ledgerPartyId", source->'orderMailId' AS "original"
    FROM "Run" import
    CROSS JOIN LATERAL jsonb_array_elements(CASE
      WHEN jsonb_typeof(import.input->'sources') = 'array' THEN import.input->'sources'
      ELSE '[]'::jsonb END) source
    WHERE import.purpose = ${runPurpose.enum.mail_import}
      AND import.status = ${runStatus.enum.completed}
      AND import."deletedAt" IS NULL
      AND import."ledgerPartyId" IS NOT NULL
      AND source->'orderMailId' IS NOT NULL
  ) membership ON membership."ledgerPartyId" = candidate."ledgerPartyId"
    AND membership.original = COALESCE(to_jsonb(candidate."orderMailId"::text), 'null'::jsonb)
  ${condition ? sql`WHERE ${condition}` : sql``}
`;
};

export const emailQualityReadSql = (ids?: SQL) => emailQualityRead(ids);

/** No derived-reading check expects unrelated or unclassified Emails. Leave
 * their evidence outside filter joins; ordinary hydration reads all classes. */
export const emailQualityFilterReadSql = () =>
  emailQualityRead(
    undefined,
    sql`candidate.classification <> ${mailboxClassification.enum.unrelated}`,
  );

/** Bounded single-record checks retain the historical containment contract. */
export const emailHasCompletedImportSql = () => sql<boolean>`EXISTS (
  SELECT 1 FROM "Run" import
  WHERE import.purpose = ${runPurpose.enum.mail_import}
    AND import.status = ${runStatus.enum.completed}
    AND import."deletedAt" IS NULL
    AND import."ledgerPartyId" = "Email"."ledgerPartyId"
    AND import.input @> jsonb_build_object('sources', jsonb_build_array(
      jsonb_build_object('orderMailId', "Email"."orderMailId"::text)
    ))
)`;

import { emailPurchaseLinkState } from "@cubby/schemas/email-fields";
import {
  mailboxClassificationStage,
  type MailboxClassification,
} from "@cubby/schemas/mailbox-research";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { sql, type SQL } from "drizzle-orm";

// Leaf module: data-quality bindings import these predicates, and the Email
// repository imports the list scaffold that imports those bindings.

const { rule, decision, model, resolution } = mailboxClassificationStage.enum;
/** The stages a member's review can disagree with. */
export const automatedStagesSql = sql`(${rule}, ${decision}, ${model})`;

/**
 * Correlated to the plain Email root table used by the list scaffold. Explicit
 * qualification prevents Drizzle's single-table SELECT from turning the inner
 * identity comparison into a self-comparison. Thread context is not a link.
 * Accepted Orders on any member of the canonical source family survive cache
 * disposal and historical aliases; active lifecycle decisions remain separate.
 */
export const emailAcceptedEvidenceSql = (includeDeleted = false): SQL => sql`
  SELECT accepted."id" AS "sourceOrderId", accepted."purchaseId", accepted."checksum" AS "evidenceChecksum", accepted."createdAt" AS "acceptedAt",
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
    ON coalesce(family."canonicalClaimId", family."id") = root."id"
    AND family."ledgerPartyId" = root."ledgerPartyId"
    AND family."kind" = root."kind"
  INNER JOIN "ImportSourceOrder" accepted ON accepted."sourceClaimId" = family."id"
  INNER JOIN "Purchase" p ON p."id" = accepted."purchaseId" AND ${includeDeleted ? sql`true` : sql`p."deletedAt" IS NULL`}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE identity."ledgerPartyId" = "Email"."ledgerPartyId"
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
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
const emailLinkedDecisionPurchasesSql = (includeDeleted = false): SQL => sql`
  SELECT decision."purchaseId"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "OrderMailCandidateDecision" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND ${includeDeleted ? sql`true` : sql`p."deletedAt" IS NULL`}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL AND decision."decision" = ${emailPurchaseLinkState.enum.linked}
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
`;

/** Accepted families and explicit lifecycle decisions share one association policy. */
export const emailPurchaseAssociationsSql = (
  includeDeleted = false,
): SQL => sql`
  SELECT evidence."purchaseId" FROM (${emailAcceptedEvidenceSql(includeDeleted)}) evidence
  UNION ${emailLinkedDecisionPurchasesSql(includeDeleted)}
`;

/**
 * Inverse association read. The candidate set is deliberately permissive;
 * the existing association policy alone decides acceptance. Materializing
 * purchase identities before the Email join prevents a mailbox × claims join;
 * materializing eligible metadata keeps the final policy off the entire mailbox.
 */
export const purchaseAssociatedEmailsSql = (purchaseId: SQL): SQL => sql`
  WITH accepted_identities AS MATERIALIZED (
    SELECT DISTINCT identity."ledgerPartyId", identity."kind", identity."externalKey"
    FROM "ImportSourceOrder" accepted
    JOIN "ImportSourceClaim" family ON family."id" = accepted."sourceClaimId"
    JOIN "ImportSourceClaim" identity
      ON coalesce(identity."canonicalClaimId", identity."id") = coalesce(family."canonicalClaimId", family."id")
    WHERE accepted."purchaseId" = ${purchaseId}
  ), candidate_ids AS (
    SELECT candidate."id"
    FROM accepted_identities identity
    JOIN "Email" candidate ON candidate."deletedAt" IS NULL
      AND candidate."ledgerPartyId" = identity."ledgerPartyId"
      AND (
        (identity."kind" = ${importSourceKind.enum.mail_message}
          AND identity."externalKey" = candidate."provider" || ':' || candidate."mailboxId" || ':' || candidate."messageId")
        OR (identity."kind" = ${importSourceKind.enum.mail_attachment}
          AND starts_with(identity."externalKey", candidate."provider" || ':' || candidate."mailboxId" || ':' || candidate."messageId" || ':attachment:'))
      )
    UNION
    SELECT candidate."id"
    FROM "OrderMailCandidateDecision" decision
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

/**
 * The member's own Relevance for the current original: a resolution, else the
 * owner's latest independent review label on a prediction of this checksum.
 */
export const emailMemberClassificationSql =
  () => sql<MailboxClassification | null>`
  CASE WHEN "Email"."classificationStage" = ${resolution} THEN "Email"."classification" ELSE (
    SELECT label."classification"
    FROM "EmailClassificationLabel" label
    INNER JOIN "EmailClassificationObservation" prediction ON prediction."id" = label."predictionId"
    INNER JOIN "LedgerParty" owner ON owner."id" = "Email"."ledgerPartyId"
    WHERE prediction."emailId" = "Email"."id"
      AND prediction."checksum" = "Email"."checksum"
      AND label."actorUserId" = owner."userId"
    ORDER BY label."createdAt" DESC, label."id" DESC
    LIMIT 1
  ) END
`;
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
  sql<boolean>`EXISTS (${emailPurchaseAssociationsSql()})`;

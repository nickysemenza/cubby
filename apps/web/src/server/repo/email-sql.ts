import {
  mailboxClassificationStage,
  type MailboxClassification,
} from "@cubby/schemas/mailbox-research";
import { importSourceKind } from "@cubby/schemas/purchase-import";
import { sql, type SQL } from "drizzle-orm";

// Leaf module: data-quality bindings import these predicates, and the Email
// repository imports the list scaffold that imports those bindings.

const { rule, jev, model, resolution } = mailboxClassificationStage.enum;
/** The stages a member's review can disagree with. */
export const automatedStagesSql = sql`(${rule}, ${jev}, ${model})`;

/**
 * Correlated to the plain Email root table used by the list scaffold. Explicit
 * qualification prevents Drizzle's single-table SELECT from turning the inner
 * identity comparison into a self-comparison. Thread context is not a link.
 * Accepted Orders on any member of the canonical source family survive cache
 * disposal and historical aliases; active lifecycle decisions remain separate.
 */
export const emailAcceptedEvidenceSql = (includeDeleted = false): SQL => sql`
  SELECT accepted."id" AS "sourceOrderId", accepted."purchaseId", accepted."checksum" AS "evidenceChecksum", accepted."createdAt" AS "acceptedAt"
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

export const emailLifecyclePurchasesSql = (
  decision: "linked" | "dismissed",
  includeDeleted = false,
): SQL => sql`
  SELECT decision."purchaseId"
  FROM "OrderMailEvent" event
  INNER JOIN "OrderMail" original ON original."id" = event."orderMailId"
  INNER JOIN "OrderMailCandidateDecision" decision ON decision."eventId" = event."id"
  INNER JOIN "Purchase" p ON p."id" = decision."purchaseId" AND ${includeDeleted ? sql`true` : sql`p."deletedAt" IS NULL`}
  LEFT JOIN "VendorAccount" account ON account."id" = p."vendorAccountId" AND account."deletedAt" IS NULL
  WHERE original."id" = "Email"."orderMailId"
    AND original."ledgerPartyId" = "Email"."ledgerPartyId"
    AND event."supersededAt" IS NULL AND decision."decision" = ${decision}
    AND (account."ledgerPartyId" IS NULL OR account."ledgerPartyId" = "Email"."ledgerPartyId")
`;

/** Accepted families and explicit lifecycle decisions share one association policy. */
export const emailPurchaseAssociationsSql = (
  includeDeleted = false,
): SQL => sql`
  SELECT evidence."purchaseId" FROM (${emailAcceptedEvidenceSql(includeDeleted)}) evidence
  UNION ${emailLifecyclePurchasesSql("linked", includeDeleted)}
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
/** The latest rule, Jev or model result for the current original. */
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

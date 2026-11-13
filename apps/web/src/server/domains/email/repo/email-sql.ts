import { emailPurchaseLinkState } from "@cubby/schemas/email-fields";
import { entitySchema } from "@cubby/schemas/entity";
import { bindingBasis } from "@cubby/schemas/kernel/machinery";
import {
  mailboxClassificationStage,
  type MailboxClassification,
} from "@cubby/schemas/mailbox-research";
import { feedbackAuthority } from "@cubby/schemas/suggestion";
import { sql, type SQL } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

import { emailLinkDecisionsSql } from "./email-decision-sql";
import { emailReviewsSql } from "./email-decision-sql";

const { rule, decision, model, resolution } = mailboxClassificationStage.enum;
const automatedStagesSql = sql`(${rule}, ${decision}, ${model})`;

/** Accepted observations point at the reconciler's canonical Purchase identity. */
export const acceptedOrderPurchasesSql = sql`(
  SELECT observation.*, coalesce(owner."entityId", observation."purchaseId") AS "boundPurchaseId"
  FROM "SourceOrderObservation" observation
  LEFT JOIN LATERAL (
    SELECT * FROM "EvidenceBinding" binding WHERE binding."factKind"='orderObservation'
      AND binding."factId"=observation.id::text
    ORDER BY CASE binding.basis WHEN ${bindingBasis.enum.decision} THEN 0 WHEN ${bindingBasis.enum.baseline} THEN 1 ELSE 2 END LIMIT 1
  ) binding ON true
  LEFT JOIN "RecordKey" owner ON owner.entity=${entitySchema.enum.purchase} AND owner."scopeKind"='purchaseEvent'
    AND owner."scopeKey"=CASE WHEN binding.basis=${bindingBasis.enum.baseline} AND binding."scopeKind"='purchaseEvent'
      THEN binding."scopeKey" ELSE binding."eventKey" END AND owner."mergedAt" IS NULL
)`;

export const emailAcceptedEvidenceSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
  purchaseIds?: SQL,
): SQL => sql`
 SELECT accepted.id AS "sourceOrderId", p.id AS "purchaseId", accepted.checksum AS "evidenceChecksum",
   accepted."createdAt" AS "acceptedAt", accepted.checksum IS DISTINCT FROM "Email".checksum AS changed
 FROM ${acceptedOrderPurchasesSql} accepted
 JOIN "Purchase" p ON p.id=accepted."boundPurchaseId" AND ${includeDeleted ? sql`true` : notDeleted("p")}
 LEFT JOIN "VendorAccount" account ON account.id=p."vendorAccountId" AND ${notDeleted("account")}
 WHERE accepted."emailId"="Email".id AND accepted."ledgerPartyId"="Email"."ledgerPartyId"
   ${purchaseIds ? sql`AND p.id IN (${purchaseIds})` : sql``}
   AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId"="Email"."ledgerPartyId")` : sql`true`}
`;

const emailLinkedDecisionPurchasesSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
 SELECT p.id AS "purchaseId" FROM ${emailLinkDecisionsSql} decision
 JOIN "Purchase" p ON p.id=decision."purchaseId" AND ${includeDeleted ? sql`true` : notDeleted("p")}
 LEFT JOIN "VendorAccount" account ON account.id=p."vendorAccountId" AND ${notDeleted("account")}
 WHERE decision."emailId"="Email".id AND decision.active AND decision.decision=${emailPurchaseLinkState.enum.linked}
   AND ${accountOwnerScope === "respect" ? sql`(account."ledgerPartyId" IS NULL OR account."ledgerPartyId"="Email"."ledgerPartyId")` : sql`true`}
`;
export const emailPurchaseAssociationsSql = (
  includeDeleted = false,
  accountOwnerScope: "respect" | "ignore" = "respect",
): SQL => sql`
 SELECT evidence."purchaseId" FROM (${emailAcceptedEvidenceSql(includeDeleted, accountOwnerScope)}) evidence
 UNION ${emailLinkedDecisionPurchasesSql(includeDeleted, accountOwnerScope)}
`;
export const purchaseAssociatedEmailsSql = (purchaseId: SQL): SQL => sql`
 SELECT "Email".* FROM "Email" WHERE ${notDeleted("Email")}
 AND EXISTS (SELECT 1 FROM (${emailPurchaseAssociationsSql()}) association WHERE association."purchaseId"=${purchaseId})
`;
export const emailSourceClaimCandidateSql = sql`EXISTS (
 SELECT 1 FROM "SourceOrderObservation" accepted WHERE accepted."emailId"="Email".id
)`;
export const purchaseMailPartiesSql = (purchases: SQL): SQL => sql`
 SELECT DISTINCT association."purchaseId", "Email"."ledgerPartyId"
 FROM "Email" CROSS JOIN LATERAL (${emailPurchaseAssociationsSql(false, "ignore")}) association
 JOIN (${purchases}) purchase ON purchase.id=association."purchaseId" AND ${notDeleted("purchase")}
 WHERE ${notDeleted("Email")}
`;

/**
 * The member's own Relevance for the current original: a resolution, else the
 * owner's latest independent review label on a prediction of this checksum.
 */
const memberClassificationWithResolutionSql = (email: SQL, reviewed: SQL) =>
  sql<MailboxClassification | null>`CASE
    WHEN ${email}."classificationStage" = ${resolution} THEN ${email}.classification
    ELSE ${reviewed} END`;

export const emailMemberClassificationSql = () =>
  memberClassificationWithResolutionSql(
    sql`"Email"`,
    sql`(
    SELECT label.classification
    FROM ${emailReviewsSql} label
    INNER JOIN "LedgerParty" owner ON owner."id" = "Email"."ledgerPartyId"
    WHERE label."emailId" = "Email"."id"
      AND label."checksum" = "Email"."checksum"
      AND label."actorUserId" = owner."userId" AND label.authority = ${feedbackAuthority.enum.member}
      AND label.classification IS NOT NULL
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

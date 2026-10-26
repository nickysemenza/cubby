import { aiEvaluationTargetKind } from "@cubby/schemas/ai-evaluation";
import { imageProcessingJobState } from "@cubby/schemas/image-processing";
import { jobState } from "@cubby/schemas/job";
import { relationshipQueryDefinition } from "@cubby/schemas/relationship-query-definitions";
import { sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { sourceTransactionSettlements } from "~/server/db/computed/source-transaction-settlement-sql";
import { notDeleted } from "~/server/db/helpers/predicates";
import { purchase as purchaseTable } from "~/server/db/retained-tables";
import {
  purchaseAssociatedEmailsSql,
  emailPurchaseAssociationsSql,
} from "~/server/domains/email/repo/email-sql";
import { purchasePurchaserSetSql } from "~/server/domains/purchase/repo/purchase-purchaser";

const livePurchases = new QueryBuilder()
  .select({ id: purchaseTable.id, vendorId: purchaseTable.vendorId })
  .from(purchaseTable)
  .where(notDeleted(purchaseTable));

/** One condition owner for graph, connected tables and relationship filters. */
export function relationshipQueryCondition(
  key: string,
  source: string,
  target: string,
): SQL {
  const query = relationshipQueryDefinition(key);
  const s = (column: string) =>
    sql`${sql.identifier(source)}.${sql.identifier(column)}`;
  const t = (column: string) =>
    sql`${sql.identifier(target)}.${sql.identifier(column)}`;
  // Malformed retained inputs must not turn an unrelated graph read into a cast error.
  const evaluationId = sql`CASE WHEN ${s("input")}->>'evaluationId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (${s("input")}->>'evaluationId')::uuid END`;
  switch (query.kind) {
    case "jobSubject":
      return sql`${s("subjectKind")} = ${query.target} AND ${s("subjectId")} = ${t("id")}::text`;
    case "evaluationRuns":
      return sql`${s("kind")} = 'ai.evaluation' AND (EXISTS (
        SELECT 1 FROM "AiEvaluationRequest" request
        WHERE request."evaluationId" = ${evaluationId} AND request."runId" = ${t("id")}
      ) OR EXISTS (
        SELECT 1 FROM "AiEvaluation" evaluation WHERE evaluation.id = ${evaluationId} AND evaluation."runId" = ${t("id")}
          AND NOT EXISTS (SELECT 1 FROM "AiEvaluationRequest" request WHERE request."evaluationId" = evaluation.id)
      ))`;
    case "evaluationTarget":
      return sql`${s("kind")} = 'ai.evaluation' AND EXISTS (
        SELECT 1 FROM "AiEvaluation" evaluation
        WHERE evaluation.id = ${evaluationId}
          AND evaluation.target->>'entity' = ${query.target}
          AND (evaluation.target->>'recordId' = ${t("id")}::text
            OR (evaluation.target->>${"kind"} = ${aiEvaluationTargetKind.enum.product_pair} AND evaluation.target->>'otherId' = ${t("id")}::text))
      )`;
    case "imageExecution":
      return sql`${s("kind")} IN ('image.cloud', 'image.device') AND ${s("key")} = 'image-processing:' || ${t("id")}::text`;
    case "imageLeaseDevice":
      // Expired leases still identify their holder until reclaimed or released.
      return sql`${s("state")} = ${imageProcessingJobState.enum.pending} AND EXISTS (
        SELECT 1 FROM "Job" execution
        JOIN "ImageProcessingAttempt" attempt ON attempt.id = execution."leaseToken"
        WHERE execution.kind IN ('image.cloud', 'image.device') AND execution.state = ${jobState.enum.running}
          AND execution.key = 'image-processing:' || ${s("id")}::text
          AND attempt.executor->>'deviceId' = ${t("installationId")}
      )`;
    case "purchaseEmails":
      return sql`EXISTS (SELECT 1 FROM (${purchaseAssociatedEmailsSql(s("id"))}) related WHERE related.id = ${t("id")})`;
    case "vendorEmails":
    case "vendorAccountEmails": {
      const vendor = query.kind === "vendorEmails" ? s("id") : s("vendorId");
      const owner =
        query.kind === "vendorAccountEmails"
          ? sql`AND ${t("ledgerPartyId")} = ${s("ledgerPartyId")}`
          : sql``;
      return sql`(EXISTS (SELECT 1 FROM "OrderMail" original WHERE original.id = ${t("orderMailId")}
        AND original."ledgerPartyId" = ${t("ledgerPartyId")} AND original."vendorId" = ${vendor})
        OR EXISTS (SELECT 1 FROM (${livePurchases}) purchase
          CROSS JOIN LATERAL (${purchaseAssociatedEmailsSql(sql`purchase.id`)}) related
          WHERE purchase."vendorId" = ${vendor} AND related.id = ${t("id")})) ${owner}`;
    }
    case "memberPurchases":
      return sql`EXISTS (SELECT 1 FROM (${purchasePurchaserSetSql}) purchaser WHERE purchaser.id = ${t("id")} AND purchaser.value = ${s("shortcode")})`;
    case "transactionSourceRecords":
      return sql`EXISTS (SELECT 1 FROM (${sourceTransactionSettlements}) accepted WHERE accepted."transaction" = ${s("id")} AND accepted."record" = ${t("id")})`;
    case "reviewedEmailTransactions":
      return sql`EXISTS (SELECT 1 FROM "EmailFinancialAssociation" evidence WHERE evidence."emailId" = ${s("id")} AND evidence."transactionId" = ${t("id")})`;
    case "reviewedEmailAccounts":
      return sql`EXISTS (SELECT 1 FROM "EmailFinancialAssociation" evidence WHERE evidence."emailId" = ${s("id")} AND evidence."reviewedAccountId" = ${t("id")})`;
    default:
      const unhandled: never = query;
      throw new Error(
        `No relationship query implementation for ${key}: ${unhandled}`,
      );
  }
}

/** Email-rooted acceptance reads scope the canonical policy before joining candidates. */
const emailAssociatedPurchases = (source: string): SQL => sql`
  SELECT association."purchaseId" FROM LATERAL (SELECT ${sql.identifier(source)}.*) "Email"
  CROSS JOIN LATERAL (${emailPurchaseAssociationsSql()}) association`;

const emailAssociatedVendors = (source: string): SQL => sql`
  SELECT original."vendorId" AS id FROM "OrderMail" original
    WHERE original.id = ${sql.identifier(source)}."orderMailId"
      AND original."ledgerPartyId" = ${sql.identifier(source)}."ledgerPartyId"
  UNION
  SELECT purchase."vendorId" AS id FROM (${emailAssociatedPurchases(source)}) association
    JOIN (${livePurchases}) purchase ON purchase.id = association."purchaseId"`;

/** Scope expensive association policies to candidates in either traversal direction. */
export function relationshipQueryTargets(
  key: string,
  source: string,
  outgoing: boolean,
): SQL | undefined {
  const query = relationshipQueryDefinition(key);
  if (query.kind === "purchaseEmails") {
    return outgoing
      ? sql`SELECT candidate.* FROM (${purchaseAssociatedEmailsSql(sql`${sql.identifier(source)}."id"`)}) associated
          JOIN "Email" candidate ON candidate."id" = associated."id"`
      : sql`SELECT candidate.* FROM (${emailAssociatedPurchases(source)}) associated
          JOIN "Purchase" candidate ON candidate."id" = associated."purchaseId"`;
  }
  if (query.kind !== "vendorEmails" && query.kind !== "vendorAccountEmails")
    return undefined;
  const account = query.kind === "vendorAccountEmails";
  if (!outgoing) {
    return account
      ? sql`SELECT candidate.* FROM (${emailAssociatedVendors(source)}) associated
          JOIN "VendorAccount" candidate ON candidate."vendorId" = associated.id
            AND candidate."ledgerPartyId" = ${sql.identifier(source)}."ledgerPartyId"`
      : sql`SELECT candidate.* FROM (${emailAssociatedVendors(source)}) associated
          JOIN "Vendor" candidate ON candidate.id = associated.id`;
  }
  const vendor = sql`${sql.identifier(source)}.${sql.identifier(account ? "vendorId" : "id")}`;
  return sql`SELECT candidate.* FROM (
      SELECT related.id FROM (${livePurchases}) purchase
        CROSS JOIN LATERAL (${purchaseAssociatedEmailsSql(sql`purchase.id`)}) related
        WHERE purchase."vendorId" = ${vendor}
      UNION
      SELECT sender.id FROM "Email" sender
        JOIN "OrderMail" original ON original.id = sender."orderMailId"
          AND original."ledgerPartyId" = sender."ledgerPartyId"
        WHERE original."vendorId" = ${vendor}
    ) associated JOIN "Email" candidate ON candidate.id = associated.id
    ${account ? sql`WHERE candidate."ledgerPartyId" = ${sql.identifier(source)}."ledgerPartyId"` : sql``}`;
}

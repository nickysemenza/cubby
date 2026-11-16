import { entitySchema } from "@cubby/schemas/entity";
import { bindingBasis } from "@cubby/schemas/kernel/machinery";
import { decisionChannel, decisionKind } from "@cubby/schemas/kernel/stage";
import { mailEvent } from "@cubby/schemas/mailbox-research";
import { sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { sourceOrderObservation } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { decisionProjectionColumns } from "~/server/domains/email/repo/decision-projection";

/** Accepted observations point at the reconciler's canonical Purchase identity. */
export const acceptedOrderPurchasesSql = sql`(
  SELECT observation.*, owner."entityId" AS "acceptedPurchaseId",
    CASE WHEN owner."rejectedAt" IS NULL THEN owner."entityId" END AS "boundPurchaseId"
  FROM "SourceOrderObservation" observation
  LEFT JOIN LATERAL (
    SELECT * FROM "EvidenceBinding" binding WHERE binding."factKind"='orderObservation'
      AND binding."factId"=observation.id::text
    ORDER BY CASE binding.basis WHEN ${sqlEnumConstant(bindingBasis, bindingBasis.enum.decision)} THEN 0 WHEN ${sqlEnumConstant(bindingBasis, bindingBasis.enum.baseline)} THEN 1 ELSE 2 END LIMIT 1
  ) binding ON true
  LEFT JOIN "RecordKey" owner ON owner.entity=${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)} AND owner."scopeKind"='purchaseEvent'
    AND owner."scopeKey"=CASE WHEN binding.basis=${sqlEnumConstant(bindingBasis, bindingBasis.enum.baseline)} AND binding."scopeKind"='purchaseEvent'
      THEN binding."scopeKey" ELSE binding."eventKey" END AND owner."mergedAt" IS NULL
)`;

/** Immutable accepted line identity joined to its current record without repointing the evidence. */
export const acceptedOrderLinesSql = sql`(
 SELECT accepted.id AS "sourceOrderId", accepted."boundPurchaseId"::uuid AS "purchaseId",
   (binding->>'lineIndex')::int AS "lineIndex", (binding->>'productId')::uuid AS "productId",
   CASE WHEN choice.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.none)} THEN owned."entityId"::uuid
     WHEN choice.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)} AND jsonb_typeof(choice.value)='string' THEN (choice.value#>>'{}')::uuid
     ELSE coalesce((binding->>'legacyExpenseId')::uuid,owned."entityId"::uuid) END AS "expenseId",
   accepted.extraction, jsonb_build_object('checksum',accepted.checksum,'extraction',accepted.extraction) AS "originalOrder"
 FROM ${acceptedOrderPurchasesSql} accepted
 LEFT JOIN LATERAL (
   SELECT p."scopeKey" FROM "RecordKey" p WHERE p.entity=${sqlEnumConstant(entitySchema, entitySchema.enum.purchase)} AND p."entityId"=accepted."boundPurchaseId"
     AND p."scopeKind"='purchaseEvent' AND p."mergedAt" IS NULL AND p."rejectedAt" IS NULL
   ORDER BY p."scopeKey" LIMIT 1
 ) owner ON true
 LEFT JOIN LATERAL (
   SELECT f.key FROM "FactKey" f WHERE f."factKind"='orderObservation' AND f."factId"=accepted.id::text
     AND f.key LIKE 'order:'||accepted."ledgerPartyId"::text||':%' LIMIT 1
 ) event ON true
 CROSS JOIN LATERAL jsonb_array_elements(accepted."productBindings") binding
 LEFT JOIN LATERAL (
   SELECT d.kind,d.value FROM "Decision" d WHERE d.channel=${sqlEnumConstant(decisionChannel, decisionChannel.enum.assignment)}
     AND d.subject IN ('purchaseEvent:'||owner."scopeKey",'purchaseEvent:'||event.key)
     AND d.field='line-record:'||coalesce(binding->>'stableLineId',binding->>'lineIndex')
   ORDER BY d.at DESC,d.id DESC LIMIT 1
 ) choice ON true
 LEFT JOIN "RecordKey" owned ON owned.entity=${sqlEnumConstant(entitySchema, entitySchema.enum.expense)} AND owned."scopeKind"='purchaseEvent'
   AND owned."scopeKey"=owner."scopeKey" AND owned."mergedAt" IS NULL AND owned."rejectedAt" IS NULL
   AND owned."naturalKey"=CASE WHEN accepted.extraction#>>'{candidate,sourceEvent}'=${sqlEnumConstant(mailEvent, mailEvent.enum.refunded)} THEN 'refund:'||accepted.id::text||':' ELSE '' END
      || 'line:' || coalesce(binding->>'stableLineId',binding->>'lineIndex')
)`;

/** Typed accepted sources expose the bound Purchase rather than a mutable import claim. */
export const acceptedOrders = new QueryBuilder()
  .select({
    ...decisionProjectionColumns(sourceOrderObservation),
    purchaseId: sql<
      import("@cubby/schemas/identifiers").PurchaseId | null
    >`"SourceOrderObservation"."boundPurchaseId"`.as("purchaseId"),
  })
  .from(sql`${acceptedOrderPurchasesSql} "SourceOrderObservation"`)
  .as("accepted_orders");

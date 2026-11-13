import {QueryBuilder} from "drizzle-orm/pg-core";
import {sourceOrderObservation} from "~/server/db/retained-tables";
import {decisionProjectionColumns} from "~/server/domains/email/repo/decision-projection";
import {sql} from "drizzle-orm";
import {entitySchema} from "@cubby/schemas/entity";
import {bindingBasis} from "@cubby/schemas/kernel/machinery";

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


/** Immutable accepted line identity joined to its current record without repointing the evidence. */
export const acceptedOrderLinesSql = sql`(
 SELECT accepted.id AS "sourceOrderId", accepted."boundPurchaseId"::uuid AS "purchaseId",
   (binding->>'lineIndex')::int AS "lineIndex", (binding->>'productId')::uuid AS "productId",
   coalesce((binding->>'legacyExpenseId')::uuid,owned."entityId"::uuid) AS "expenseId",
   accepted.extraction, jsonb_build_object('checksum',accepted.checksum,'extraction',accepted.extraction) AS "originalOrder"
 FROM ${acceptedOrderPurchasesSql} accepted
 CROSS JOIN LATERAL jsonb_array_elements(accepted."productBindings") binding
 LEFT JOIN "RecordKey" owned ON owned.entity='expense' AND owned."scopeKind"='purchaseEvent'
   AND owned."scopeKey"=(SELECT p."scopeKey" FROM "RecordKey" p WHERE p.entity='purchase' AND p."entityId"=accepted."boundPurchaseId" LIMIT 1)
   AND owned."naturalKey"=CASE WHEN accepted.extraction#>>'{candidate,sourceEvent}'='refunded' THEN 'refund:'||accepted.id::text||':' ELSE '' END
      || 'line:' || coalesce(binding->>'stableLineId',binding->>'lineIndex')
)`;

/** Typed accepted sources expose the bound Purchase rather than a mutable import claim. */
export const acceptedOrders = new QueryBuilder().select({
  ...decisionProjectionColumns(sourceOrderObservation),
  purchaseId: sql<import("@cubby/schemas/identifiers").PurchaseId|null>`"SourceOrderObservation"."boundPurchaseId"`.as("purchaseId"),
}).from(sql`${acceptedOrderPurchasesSql} "SourceOrderObservation"`).as("accepted_orders");

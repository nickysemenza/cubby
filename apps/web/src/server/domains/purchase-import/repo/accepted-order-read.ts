import { entitySchema } from "@cubby/schemas/entity";
import { bindingBasis } from "@cubby/schemas/kernel/machinery";
import { decisionChannel, decisionKind } from "@cubby/schemas/kernel/stage";
import { mailEvent } from "@cubby/schemas/mailbox-research";
import { sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceOrderObservation } from "~/server/db/retained-tables";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import { decisionProjectionColumns } from "~/server/domains/email/repo/decision-projection";

const purchaseEntity = sqlEnumConstant(
  entitySchema,
  entitySchema.enum.purchase,
);

const acceptedOrderProjection = (observationScope?: SQL) => sql`(
  SELECT observation.*, owner."entityId" AS "acceptedPurchaseId",
    CASE WHEN owner."rejectedAt" IS NULL THEN live_owner.id END AS "boundPurchaseId"
  FROM "SourceOrderObservation" observation
  LEFT JOIN LATERAL (
    SELECT * FROM "EvidenceBinding" binding WHERE binding."factKind"='orderObservation'
      AND binding."factId"=observation.id::text
    ORDER BY CASE binding.basis WHEN ${sqlEnumConstant(bindingBasis, bindingBasis.enum.decision)} THEN 0 WHEN ${sqlEnumConstant(bindingBasis, bindingBasis.enum.baseline)} THEN 1 ELSE 2 END LIMIT 1
  ) binding ON true
  LEFT JOIN "RecordKey" owner ON owner.entity=${purchaseEntity} AND owner."scopeKind"='purchaseEvent'
    AND owner."scopeKey"=CASE WHEN binding.basis=${sqlEnumConstant(bindingBasis, bindingBasis.enum.baseline)} AND binding."scopeKind"='purchaseEvent'
      THEN binding."scopeKey" ELSE binding."eventKey" END AND owner."mergedAt" IS NULL
  LEFT JOIN "Purchase" live_owner ON live_owner.id=owner."entityId" AND ${notDeleted("live_owner")}
  ${observationScope ? sql`WHERE ${observationScope}` : sql``}
)`;

/** Accepted observations point at the reconciler's canonical Purchase identity. */
export const acceptedOrderPurchasesSql = acceptedOrderProjection();

/** Resolve bindings only for observations belonging to the requested Email and party. */
export const acceptedOrdersForEmailSql = (emailId: SQL, ledgerPartyId: SQL) =>
  acceptedOrderProjection(sql`observation."emailId"=${emailId}
    AND observation."ledgerPartyId"=${ledgerPartyId}`);

/**
 * Accepted observations whose bound Purchase satisfies `bound`. The ranked
 * binding and `boundPurchaseId` are computed per observation and cannot be
 * filtered before that work, so a read keyed by Purchase must use this form:
 * the Purchases' event keys select the candidate observations through the
 * RecordKey and EvidenceBinding indexes, then the full projection rechecks
 * each one. Filtering `acceptedOrderPurchasesSql` by `boundPurchaseId`
 * instead evaluates every observation per outer row.
 */
export const acceptedOrdersBoundToSql = (
  bound: (purchaseId: SQL) => SQL,
): SQL => sql`(
  SELECT bound_order.* FROM ${acceptedOrderProjection(sql`observation.id IN (
    SELECT CASE WHEN pg_input_is_valid(candidate."factId", ${"uuid"}) THEN candidate."factId"::uuid END
    FROM "RecordKey" candidate_owner
    JOIN "EvidenceBinding" candidate ON candidate."factKind"='orderObservation'
      AND (candidate."eventKey"=candidate_owner."scopeKey"
        OR (candidate."scopeKind"='purchaseEvent' AND candidate."scopeKey"=candidate_owner."scopeKey"))
    WHERE candidate_owner.entity=${purchaseEntity} AND candidate_owner."scopeKind"='purchaseEvent'
      AND candidate_owner."mergedAt" IS NULL AND candidate_owner."rejectedAt" IS NULL
      AND ${bound(sql`candidate_owner."entityId"`)}
  )`)} bound_order
  WHERE ${bound(sql`bound_order."boundPurchaseId"`)}
)`;

const acceptedOrderLinesFrom = (acceptedOrdersSql: SQL) => sql`(
 SELECT accepted.id AS "sourceOrderId", accepted."boundPurchaseId"::uuid AS "purchaseId",
   (binding->>'lineIndex')::int AS "lineIndex", (binding->>'productId')::uuid AS "productId",
   CASE WHEN choice.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.none)} THEN owned."entityId"::uuid
     WHEN choice.kind=${sqlEnumConstant(decisionKind, decisionKind.enum.set)} AND jsonb_typeof(choice.value)='string' THEN (choice.value#>>'{}')::uuid
     ELSE coalesce((binding->>'legacyExpenseId')::uuid,owned."entityId"::uuid) END AS "expenseId",
   accepted.extraction, jsonb_build_object('checksum',accepted.checksum,'extraction',accepted.extraction) AS "originalOrder"
 FROM ${acceptedOrdersSql} accepted
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

/** Immutable accepted line identity joined to its current record without repointing the evidence. */
export const acceptedOrderLinesSql = acceptedOrderLinesFrom(
  acceptedOrderPurchasesSql,
);

/** Accepted lines for reads keyed by Purchase; see `acceptedOrdersBoundToSql`. */
export const acceptedOrderLinesBoundToSql = (bound: (purchaseId: SQL) => SQL) =>
  acceptedOrderLinesFrom(acceptedOrdersBoundToSql(bound));

const acceptedOrdersFrom = (source: SQL) =>
  new QueryBuilder()
    .select({
      ...decisionProjectionColumns(sourceOrderObservation),
      purchaseId: sql<
        import("@cubby/schemas/identifiers").PurchaseId | null
      >`"SourceOrderObservation"."boundPurchaseId"`.as("purchaseId"),
    })
    .from(sql`${source} "SourceOrderObservation"`)
    .where(sql`"SourceOrderObservation"."boundPurchaseId" IS NOT NULL`)
    .as("accepted_orders");

/** Typed accepted sources expose the bound Purchase rather than a mutable import claim. */
export const acceptedOrders = acceptedOrdersFrom(acceptedOrderPurchasesSql);

/** `acceptedOrders` for reads keyed by Purchase; see `acceptedOrdersBoundToSql`. */
export const acceptedOrdersBoundTo = (bound: (purchaseId: SQL) => SQL) =>
  acceptedOrdersFrom(acceptedOrdersBoundToSql(bound));

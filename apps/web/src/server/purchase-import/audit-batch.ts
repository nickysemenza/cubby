import type { RunId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { PurchaseAuditRenderedBatch } from "~/server/agents/purchase-import/prompts";
import type { Database } from "~/server/db";
import {
  expense,
  auditLog,
  product,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * A successor also audits matching unaudited predecessor writes. Stop at an
 * audited boundary and never cross owner, actor, account, vendor or purpose;
 * distinct Purchase ids keep repeated writes and retry chains neutral.
 */
export async function loadPurchaseAuditBatch(
  db: Database,
  runId: RunId,
  offset = 0,
): Promise<PurchaseAuditRenderedBatch> {
  const importedPurchases = await getDb(db)
    .selectDistinct({
      id: purchase.id,
      orderId: purchase.orderId,
      statedTotal: purchase.statedTotal,
      displayLabel: purchase.displayLabel,
    })
    .from(auditLog)
    .innerJoin(
      purchase,
      and(eq(purchase.id, auditLog.entityId), notDeleted(purchase)),
    )
    .where(
      and(
        inArray(
          auditLog.runId,
          sql`(WITH RECURSIVE audit_runs AS (
            SELECT r."id", r."predecessorRunId", r."ledgerPartyId", r."actorUserId",
              r."vendorAccountId", r."vendorId", r."purpose", ARRAY[r."id"] AS visited
            FROM "Run" r WHERE r."id" = ${runId} AND r."deletedAt" IS NULL
            UNION ALL
            SELECT p."id", p."predecessorRunId", p."ledgerPartyId", p."actorUserId",
              p."vendorAccountId", p."vendorId", p."purpose", a.visited || p."id"
            FROM "Run" p JOIN audit_runs a ON p."id" = a."predecessorRunId"
            WHERE p."deletedAt" IS NULL AND p."auditedAt" IS NULL
              AND p."ledgerPartyId" = a."ledgerPartyId"
              AND p."actorUserId" = a."actorUserId"
              AND p."vendorAccountId" IS NOT DISTINCT FROM a."vendorAccountId"
              AND p."vendorId" IS NOT DISTINCT FROM a."vendorId"
              AND p."purpose" = a."purpose"
              AND NOT p."id" = ANY(a.visited)
          ) SELECT "id" FROM audit_runs)`,
        ),
        eq(auditLog.entityKind, "purchase"),
      ),
    )
    .orderBy(asc(purchase.id))
    .limit(25)
    .offset(offset);
  if (importedPurchases.length === 0) return [];
  const purchaseIds = importedPurchases.map(({ id }) => id);
  const [expenseRows, paymentRows] = await Promise.all([
    getDb(db)
      .select({
        purchaseId: expense.purchaseId,
        id: expense.id,
        name: expense.name,
        amount: expense.cost,
        lineKind: expense.lineKind,
        quantity: expense.productQuantity,
        productId: product.id,
        productName: product.name,
        productManufacturer: product.manufacturer,
        productModel: product.model,
      })
      .from(expense)
      .leftJoin(
        product,
        and(eq(product.id, expense.productId), notDeleted(product)),
      )
      .where(
        and(inArray(expense.purchaseId, purchaseIds), notDeleted(expense)),
      ),
    getDb(db)
      .select({
        purchaseId: purchasePaymentEvidence.purchaseId,
        amount: purchasePaymentEvidence.amount,
        chargedAt: purchasePaymentEvidence.chargedAt,
        cardLastFour: purchasePaymentEvidence.cardLastFour,
        description: purchasePaymentEvidence.description,
      })
      .from(purchasePaymentEvidence)
      .where(inArray(purchasePaymentEvidence.purchaseId, purchaseIds)),
  ]);
  return importedPurchases.map((row) => ({
    ...row,
    expenses: expenseRows
      .filter((expenseRow) => expenseRow.purchaseId === row.id)
      .map((expenseRow) => ({
        id: expenseRow.id,
        name: expenseRow.name,
        amount: expenseRow.amount,
        lineKind: expenseRow.lineKind,
        quantity: expenseRow.quantity,
        product: expenseRow.productId
          ? {
              id: expenseRow.productId,
              name: expenseRow.productName,
              manufacturer: expenseRow.productManufacturer,
              model: expenseRow.productModel,
            }
          : null,
      })),
    paymentEvidence: paymentRows
      .filter((payment) => payment.purchaseId === row.id)
      .map(({ purchaseId: _purchaseId, ...payment }) => payment),
  }));
}

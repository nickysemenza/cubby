import type { RunId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray } from "drizzle-orm";

import type { PurchaseAuditRenderedBatch } from "~/server/agents/purchase-import/prompts";
import type { Database } from "~/server/db";
import {
  expense,
  runMutation,
  product,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/** The read-only source batch shared by production audit and manual AI probes. */
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
    .from(runMutation)
    .innerJoin(
      purchase,
      and(eq(purchase.id, runMutation.targetId), notDeleted(purchase)),
    )
    .where(
      and(eq(runMutation.runId, runId), eq(runMutation.targetKind, "purchase")),
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

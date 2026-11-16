import type { RunId } from "@cubby/schemas/identifiers";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";

import type { PurchaseAuditRenderedBatch } from "~/server/ai/policy/prompts/purchase-import";
import type { Database } from "~/server/db";
import { expenseCostDollarsSql } from "~/server/db/computed/expense-aggregate-sql";
import { minorToDollarsSql } from "~/server/db/computed/money";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import { getDb, notDeleted } from "~/server/db/helpers";
import {
  expense,
  auditLog,
  product,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";

/** A completed command's actual insert receipts, independent of publication channel. */
export const importRunAuditReceiptSql = (
  runIds: SQL,
  auditId: SQL,
): SQL => sql`EXISTS (
  SELECT 1 FROM "RunOperation" operation WHERE operation."runId" IN (${runIds})
    AND operation.kind=${"commit_purchase_import"} AND operation.state=${"completed"}
    AND operation.result->'auditIds' ? ${auditId}::text
)`;

/** A Purchase's financial graph includes its separately audited item records. */
export const purchaseAuditTargetSql = (
  id: SQL,
  kind: SQL,
  entityId: SQL,
): SQL => sql`/* includes-deleted: Removed items retain their Purchase audit history. */ (
  (${kind}=${"purchase"} AND ${entityId}=${id}) OR
  (${kind}=${"expense"} AND EXISTS (SELECT 1 FROM "Expense" item
    WHERE item.id=${entityId} AND item."purchaseId"=${id}))
)`;

/** Actual Purchase and item audit receipts identify the Run's judgment writes. */
export const purchaseImportJudgmentSql = (runIds: SQL): SQL => sql`EXISTS (
  SELECT 1 FROM ${auditLog} judged WHERE
    (judged."entityKind"=${"purchase"} AND judged."entityId"=${purchase.id}
      AND judged.channel=${"mcp"} AND judged."runId" IN (${runIds})) OR
    (${purchaseAuditTargetSql(sql`${purchase.id}`, sql`judged."entityKind"`, sql`judged."entityId"`)}
      AND ${importRunAuditReceiptSql(runIds, sql`judged.id`)})
)`;

/**
 * A successor also audits matching unaudited predecessor writes. Stop at an
 * audited boundary and never cross owner, actor, account, vendor or purpose;
 * distinct Purchase ids keep repeated writes and retry chains neutral. Only
 * writes the agent made by judgment are rendered; a Run with none audits nothing.
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
      statedTotal: sql<
        number | null
      >`${minorToDollarsSql(purchase.statedTotal, "numeric")}`.mapWith(Number),
      displayLabel: purchase.displayLabel,
    })
    .from(purchase)
    .where(
      and(
        notDeleted(purchase),
        purchaseImportJudgmentSql(
          sql`(WITH RECURSIVE audit_runs AS (
            SELECT r."id", r."predecessorRunId", r."ledgerPartyId", r."actorUserId",
              r."vendorAccountId", r."vendorId", r."purpose", ARRAY[r."id"] AS visited
            FROM "Run" r WHERE r."id" = ${runId} AND ${notDeleted("r")}
            UNION ALL
            SELECT p."id", p."predecessorRunId", p."ledgerPartyId", p."actorUserId",
              p."vendorAccountId", p."vendorId", p."purpose", a.visited || p."id"
            FROM "Run" p JOIN audit_runs a ON p."id" = a."predecessorRunId"
            WHERE ${notDeleted("p")} AND p."auditedAt" IS NULL
              AND p."ledgerPartyId" = a."ledgerPartyId"
              AND p."actorUserId" = a."actorUserId"
              AND p."vendorAccountId" IS NOT DISTINCT FROM a."vendorAccountId"
              AND p."vendorId" IS NOT DISTINCT FROM a."vendorId"
              AND p."purpose" = a."purpose"
              AND NOT p."id" = ANY(a.visited)
          ) SELECT "id" FROM audit_runs)`,
        ),
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
        amount: expenseCostDollarsSql(),
        lineKind: expense.lineKind,
        lineBasis: expense.lineBasis,
        costType: expense.costType,
        quantity: expense.productQuantity,
        productId: product.id,
        productName: product.name,
        productManufacturer: productBrandNameSql(product.brandId),
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
        amount: minorToDollarsSql(
          purchasePaymentEvidence.amountMinor,
          "numeric",
        ).mapWith(Number),
        chargedAt: purchasePaymentEvidence.chargedAt,
        cardLastFour: purchasePaymentEvidence.cardLastFour,
        tender: purchasePaymentEvidence.tender,
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
        lineBasis: expenseRow.lineBasis,
        costType: expenseRow.costType,
        quantity: expenseRow.quantity,
        product: expenseRow.productId
          ? {
              id: expenseRow.productId,
              name: expenseRow.productName,
              brandName: expenseRow.productManufacturer,
              model: expenseRow.productModel,
            }
          : null,
      })),
    paymentEvidence: paymentRows
      .filter((payment) => payment.purchaseId === row.id)
      .map(({ purchaseId: _purchaseId, ...payment }) => payment),
  }));
}

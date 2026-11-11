import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import {
  entityAttachment,
  expense,
  expenseAttribution,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  purchase,
  purchasePaymentEvidence,
  sourceOrderObservation,
} from "~/server/db/schema";
import { logAuditEntries } from "~/server/generic/audit-log/repo/audit-log";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  planReconciliationLine,
  planReconciliationBindings,
  type ReconciliationPlan,
} from "./reconciliation-plan";
import {
  type ReconciliationFix,
  type ReconciliationState,
} from "./reconciliation-state";

export type ReconciliationExpenseContext = {
  audit: Parameters<typeof logAuditEntries>[2];
  reused: Set<typeof expense.$inferSelect.id>;
  resolvedBindings: { lineIndex: number; productId: ProductId | null }[];
  lineExpenses: Map<number, typeof expense.$inferSelect.id>;
};
export function newReconciliationExpenseContext(): ReconciliationExpenseContext {
  return {
    audit: [],
    reused: new Set(),
    resolvedBindings: [],
    lineExpenses: new Map(),
  };
}

export async function applyReconciliationLine(
  tx: DrizzleTransaction,
  action: ReturnType<typeof planReconciliationLine>,
  applied: ReconciliationExpenseContext,
) {
  const { binding, line, existing } = action.entry;
  const { audit, reused, lineExpenses } = applied;
  if (action.kind === "attach") {
    if (existing) lineExpenses.set(binding.lineIndex, existing.id);
    if (existing && action.fields) {
      await tx
        .update(expense)
        .set({ ...action.fields, updatedAt: new Date() })
        .where(eq(expense.id, existing.id));
      audit.push({
        entityKind: "expense",
        entityId: existing.id,
        action: "update",
        changes: { productId: { from: null, to: action.productId } },
      });
    }
    return {
      row: null,
      findingId: action.finding ? (existing?.id ?? null) : null,
    };
  }
  let row;
  if (existing && action.reuse) {
    [row] = await tx
      .update(expense)
      .set({ ...action.fields, updatedAt: new Date() })
      .where(eq(expense.id, existing.id))
      .returning();
    reused.add(existing.id);
    audit.push({
      entityKind: "expense",
      entityId: existing.id,
      action: "update",
      changes: {
        cost: { from: existing.cost, to: action.fields.cost },
        name: { from: existing.name, to: line.title },
        productId: { from: existing.productId, to: action.productId },
      },
    });
    await tx
      .update(expenseAttribution)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(expenseAttribution.expenseId, existing.id),
          notDeleted(expenseAttribution),
        ),
      );
  } else {
    row = await insertWithShortcode(tx, "expense", action.fields);
    audit.push({ entityKind: "expense", entityId: row.id, action: "create" });
  }
  if (!row) throw new Error("The reviewed Expense changed during commit.");
  lineExpenses.set(binding.lineIndex, row.id);
  if (action.allocations.length)
    await tx.insert(expenseAttribution).values(
      action.allocations.map((allocation) => ({
        expenseId: row.id,
        ...allocation,
      })),
    );
  return { row, findingId: action.finding ? row.id : null };
}

export async function applyReconciliationRemovals(
  tx: DrizzleTransaction,
  ids: readonly (typeof expense.$inferSelect.id)[],
) {
  if (ids.length)
    await tx
      .update(expense)
      .set({ deletedAt: new Date() })
      .where(inArray(expense.id, [...ids]));
}

export async function applyReconciliationHeader(
  tx: DrizzleTransaction,
  plan: ReconciliationPlan,
  applied: ReconciliationExpenseContext,
) {
  const { purchaseId, statedTotal, orderId, imageIds } = plan.header;
  if (statedTotal)
    await tx
      .update(purchase)
      .set({ statedTotal: statedTotal.value, updatedAt: new Date() })
      .where(eq(purchase.id, purchaseId));
  if (orderId !== null) {
    await tx
      .update(purchase)
      .set({ orderId, updatedAt: new Date() })
      .where(eq(purchase.id, purchaseId));
    applied.audit.push({
      entityKind: "purchase",
      entityId: purchaseId,
      action: "update",
      changes: { orderId: { from: null, to: orderId } },
    });
  }
  for (const imageId of imageIds)
    await tx
      .insert(entityAttachment)
      .values({
        entityId: purchaseId,
        entityKind: "purchase",
        role: "attachment",
        imageId,
        documentKind: "order_confirmation",
      })
      .onConflictDoNothing();
}

export async function applyReconciliationAssociation(
  tx: DrizzleTransaction,
  state: ReconciliationState,
  fix: ReconciliationFix,
  firstObservation: typeof sourceOrderObservation.$inferSelect,
  acceptedObservation: typeof sourceOrderObservation.$inferSelect,
  outputFingerprint: string,
) {
  const [association] = await tx
    .insert(importSourceOrder)
    .values({
      sourceClaimId: state.observation.sourceClaimId,
      orderKey: fix.orderKey,
      purchaseId: state.target.id,
      checksum: fix.source.checksum,
      outputFingerprint,
      originalOrder: {
        checksum: firstObservation.checksum,
        extraction: firstObservation.extraction,
      },
      acceptedObservationId: acceptedObservation.id,
    })
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      // As in the writer: only a live association arbitrates, and until the
      // live-only key is applied a detached row is taken over instead.
      targetWhere: isNotNull(importSourceOrder.purchaseId),
      set: {
        purchaseId: state.target.id,
        checksum: fix.source.checksum,
        acceptedObservationId: acceptedObservation.id,
        outputFingerprint,
        ...(state.association
          ? {}
          : {
              originalOrder: {
                checksum: firstObservation.checksum,
                extraction: firstObservation.extraction,
              },
            }),
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!association)
    throw new Error("Accepted source association was not persisted.");
  return association;
}

export async function applyReconciliationSource(
  tx: DrizzleTransaction,
  plan: ReconciliationPlan,
  association: typeof importSourceOrder.$inferSelect,
  bindingPlan: Awaited<ReturnType<typeof planReconciliationBindings>>,
) {
  for (const id of bindingPlan.detached)
    await tx
      .update(importSourceProduct)
      .set({ expenseId: null })
      .where(eq(importSourceProduct.id, id));
  for (const binding of bindingPlan.bindings)
    await tx
      .insert(importSourceProduct)
      .values({ sourceOrderId: association.id, ...binding })
      .onConflictDoUpdate({
        target: [
          importSourceProduct.sourceOrderId,
          importSourceProduct.lineIndex,
        ],
        set: { expenseId: binding.expenseId },
      });
  for (const payment of plan.payments) {
    if (payment.kind === "update")
      await tx
        .update(purchasePaymentEvidence)
        .set({ ...payment.values, updatedAt: new Date() })
        .where(eq(purchasePaymentEvidence.id, payment.id));
    else
      await tx.insert(purchasePaymentEvidence).values({
        purchaseId: plan.purchaseId,
        sourceClaimId: plan.sourceClaimId,
        evidenceIndex: payment.evidenceIndex,
        ...payment.values,
      });
  }
  if (plan.surplusPaymentIds.length)
    await tx
      .delete(purchasePaymentEvidence)
      .where(inArray(purchasePaymentEvidence.id, plan.surplusPaymentIds));
  if (plan.refreshClaim)
    await tx
      .update(importSourceClaim)
      .set({ checksum: plan.refreshClaim.checksum, updatedAt: new Date() })
      .where(eq(importSourceClaim.id, plan.refreshClaim.id));
}

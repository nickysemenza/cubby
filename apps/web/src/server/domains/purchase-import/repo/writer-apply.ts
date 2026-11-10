import type { ImportWriterInput } from "@cubby/schemas/purchase-import";
import { eq, isNotNull, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  entityAttachment,
  expense,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type {
  planAttachments,
  planExpenseProductBinding,
  planFallbackExpenses,
  planOriginalBindings,
  planPaymentEvidence,
  planPurchaseHeader,
  planPurchaseNote,
  planReplayClaim,
  planSourceAssociation,
  planTenderUpdates,
} from "./writer-plan";

export async function applyPurchaseHeader(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planPurchaseHeader>,
) {
  if (plan.kind === "create")
    return insertWithShortcode(tx, "purchase", plan.values);
  await tx
    .update(purchase)
    .set(plan.values)
    .where(eq(purchase.id, plan.target.id));
  return plan.target;
}

export async function applyPaymentEvidence(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planPaymentEvidence>,
) {
  if (plan.length) await tx.insert(purchasePaymentEvidence).values(plan);
}

export async function applyExpenseProductBinding(
  tx: DrizzleTransaction,
  plan: NonNullable<ReturnType<typeof planExpenseProductBinding>>,
) {
  await tx.update(expense).set(plan.values).where(eq(expense.id, plan.id));
}

export async function applyFallbackExpenses(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planFallbackExpenses>,
) {
  return tx
    .update(expense)
    .set({ trade: "other" })
    .where(plan.where)
    .returning({ id: expense.id });
}

export async function applyReplayClaim(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planReplayClaim>,
) {
  await tx
    .update(importSourceClaim)
    .set(plan.values)
    .where(eq(importSourceClaim.id, plan.id));
}

export async function applyPurchaseNote(
  tx: DrizzleTransaction,
  plan: NonNullable<ReturnType<typeof planPurchaseNote>>,
) {
  await tx
    .update(purchase)
    .set({
      notes: sql`concat_ws(E'\n\n', nullif(${purchase.notes}, ''), ${plan.research}::text)`,
    })
    .where(eq(purchase.id, plan.purchaseId));
}

export async function applyRunCounter(
  tx: DrizzleTransaction,
  plan: { runId: ImportWriterInput["runId"]; created: boolean },
) {
  await tx.execute(
    sql`UPDATE "Run" SET "ordersSeen" = "ordersSeen" + 1, ${plan.created ? sql`"imported" = "imported" + 1` : sql`"updated" = "updated" + 1`}, "updatedAt" = now() WHERE "id" = ${plan.runId}`,
  );
}

export async function applyTenderUpdates(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planTenderUpdates>,
) {
  for (const row of plan)
    await tx
      .update(purchasePaymentEvidence)
      .set({ tender: row.tender, updatedAt: new Date() })
      .where(eq(purchasePaymentEvidence.id, row.id));
}

export async function applyAttachments(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planAttachments>,
) {
  if (plan.length)
    await tx.insert(entityAttachment).values(plan).onConflictDoNothing();
}

export async function applySourceAssociation(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planSourceAssociation>,
) {
  const [association] = await tx
    .insert(importSourceOrder)
    .values(plan.values)
    .onConflictDoUpdate({
      target: [importSourceOrder.sourceClaimId, importSourceOrder.orderKey],
      targetWhere: isNotNull(importSourceOrder.purchaseId),
      set: plan.set,
    })
    .returning({ id: importSourceOrder.id });
  if (!association) throw new Error("Import source order was not persisted");
  return association;
}

export async function applyOriginalBindings(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planOriginalBindings>,
) {
  if (plan.length) await tx.insert(importSourceProduct).values(plan);
}

export async function applyAcceptedObservation(
  tx: DrizzleTransaction,
  plan: {
    associationId: typeof importSourceOrder.$inferSelect.id;
    observationId: typeof importSourceOrder.$inferSelect.acceptedObservationId;
  },
) {
  await tx
    .update(importSourceOrder)
    .set({ acceptedObservationId: plan.observationId })
    .where(eq(importSourceOrder.id, plan.associationId));
}

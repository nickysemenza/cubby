import { eq, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import {
  expense,
  importSourceClaim,
  purchase,
  purchasePaymentEvidence,
} from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type {
  planExpenseProductBinding,
  planImportedExpense,
  planPaymentEvidence,
  planPurchaseHeader,
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
  for (const payment of plan)
    await tx.insert(purchasePaymentEvidence).values(payment);
}

export async function applyImportedExpense(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof planImportedExpense>,
) {
  return insertWithShortcode(tx, "expense", plan.values);
}

export async function applyExpenseProductBinding(
  tx: DrizzleTransaction,
  plan: NonNullable<ReturnType<typeof planExpenseProductBinding>>,
) {
  await tx.update(expense).set(plan.values).where(eq(expense.id, plan.id));
}

export async function applyAggregateExpense(
  tx: DrizzleTransaction,
  plan: NonNullable<
    ReturnType<typeof import("./writer-plan").planAggregateExpense>
  >,
) {
  return insertWithShortcode(tx, "expense", plan);
}

export async function applyFallbackExpenses(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof import("./writer-plan").planFallbackExpenses>,
) {
  return tx
    .update(expense)
    .set({ trade: "other" })
    .where(plan.where)
    .returning({ id: expense.id });
}

export async function applyReplayClaim(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof import("./writer-plan").planReplayClaim>,
) {
  await tx
    .update(importSourceClaim)
    .set(plan.values)
    .where(eq(importSourceClaim.id, plan.id));
}

export async function applyPurchaseNote(
  tx: DrizzleTransaction,
  plan: NonNullable<
    ReturnType<typeof import("./writer-plan").planPurchaseNote>
  >,
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
  plan: ReturnType<typeof import("./writer-plan").planRunCounter>,
) {
  await tx.execute(
    sql`UPDATE "Run" SET "ordersSeen" = "ordersSeen" + 1, ${plan.created ? sql`"imported" = "imported" + 1` : sql`"updated" = "updated" + 1`}, "updatedAt" = now() WHERE "id" = ${plan.runId}`,
  );
}

export async function applyTenderUpdates(
  tx: DrizzleTransaction,
  plan: ReturnType<typeof import("./writer-plan").planTenderUpdates>,
) {
  for (const row of plan)
    await tx
      .update(purchasePaymentEvidence)
      .set({ tender: row.tender, updatedAt: new Date() })
      .where(eq(purchasePaymentEvidence.id, row.id));
}

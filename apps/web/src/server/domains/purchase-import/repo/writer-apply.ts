import { eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { expense, purchase, purchasePaymentEvidence } from "~/server/db/schema";
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

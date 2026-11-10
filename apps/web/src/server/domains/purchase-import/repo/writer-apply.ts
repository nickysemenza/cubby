import { eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { purchase } from "~/server/db/schema";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import type { planPurchaseHeader } from "./writer-plan";

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

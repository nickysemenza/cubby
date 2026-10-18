import { formatCurrency } from "~/lib/number-format";
import { readAiBudget } from "~/server/ai/budget";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";

/**
 * "Run now, paid allowed" spends within the paid budget. Once this window's
 * paid budget is spent, the member must confirm a named amount past it
 * (`paidOverBudgetUsd`); the refusal carries the raw numbers to confirm.
 */
export async function assertPaidOverride(
  db: Database,
  paidOverBudgetUsd: number | undefined,
) {
  const { paid, windowEnd } = await readAiBudget(db);
  if (paid.spentUsd >= paid.limitUsd && paidOverBudgetUsd === undefined)
    throw createAppError(
      "RUN_CONTROL_REFUSED",
      `The paid AI budget is spent: ${formatCurrency(paid.spentUsd)} of ${formatCurrency(paid.limitUsd)} this window (resets ${windowEnd}). Confirm paidOverBudgetUsd to let this Run spend past it.`,
    );
}

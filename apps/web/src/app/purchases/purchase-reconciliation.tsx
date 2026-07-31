import type {
  PurchaseOut,
  PurchaseReconciliation,
} from "@cubby/schemas/purchase";
import { reconcilePurchase } from "@cubby/schemas/purchase";
import type { FC } from "react";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Description } from "~/components/ui/description";
import { formatCurrency } from "~/lib/utils";

/**
 * `statedTotal` vs `SUM(expense.cost)`, as a **soft** cue.
 *
 * Deliberately not an error tone and never a blocker: a mismatch is frequently
 * CORRECT — a partial refund reduces a line without changing what the purchase
 * itself stated — so the worst state here is `warning`, and nothing on the page
 * gates a write on it. `"unknown"` (no stated total recorded) is a quiet
 * neutral, not a problem to fix.
 *
 * The verdict itself always comes from `reconcilePurchase` in
 * `@cubby/schemas/purchase`, never re-derived here, so the list column, the
 * detail cue and the server's `notReconciling` worklist can't disagree.
 */
const TONE: Record<PurchaseReconciliation, BadgeVariant> = {
  unknown: "slate",
  match: "positive",
  mismatch: "warning",
};

const LABEL: Record<PurchaseReconciliation, string> = {
  unknown: "No stated total",
  match: "Reconciles",
  mismatch: "Off",
};

/** The delta the paperwork and the lines disagree by (mismatch only). */
export const reconciliationDelta = (purchase: {
  statedTotal: number | null;
  expenseTotal: number;
}): number | null =>
  purchase.statedTotal === null
    ? null
    : purchase.expenseTotal - purchase.statedTotal;

export const ReconciliationBadge: FC<{
  purchase: Pick<PurchaseOut, "statedTotal" | "expenseTotal">;
}> = ({ purchase }) => {
  const status = reconcilePurchase(purchase);
  const delta = reconciliationDelta(purchase);

  return (
    <Badge variant={TONE[status]}>
      {status === "mismatch" && delta !== null
        ? `${LABEL.mismatch} ${formatCurrency(delta)}`
        : LABEL[status]}
    </Badge>
  );
};

/**
 * The sentence that keeps the cue from reading as a bug report. Rendered under
 * the numbers on the detail page; the list column shows the badge alone.
 */
export const ReconciliationNote: FC<{
  status: PurchaseReconciliation;
}> = ({ status }) => (
  <Description size="xs">
    {status === "unknown" &&
      "No stated total recorded yet — nothing to compare the expenses against. Add what the receipt or invoice says to turn this into a cue."}
    {status === "match" &&
      "The expenses add up to what the purchase stated. Stated totals are never summed into spend — spend is always the expenses."}
    {status === "mismatch" &&
      "The expenses don't add up to what the purchase stated. That's often correct: a partial refund reduces an expense without changing what the paperwork claimed. Nothing here needs fixing unless an expense is genuinely wrong or missing."}
  </Description>
);

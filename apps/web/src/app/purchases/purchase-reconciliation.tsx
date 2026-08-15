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
 * Deliberately never a blocker. A difference exactly explained by posted refund
 * evidence is `refund_adjusted` and neutral; only an unexplained difference gets
 * the warning-toned `mismatch`. `"unknown"` (no stated total recorded) is a
 * quiet neutral, not a problem to fix.
 *
 * The verdict itself always comes from `reconcilePurchase` in
 * `@cubby/schemas/purchase`, never re-derived here, so the list column, the
 * detail cue and the server's `notReconciling` worklist can't disagree.
 */
const STATUS_PRESENTATION: Record<
  PurchaseReconciliation,
  { label: string; variant: BadgeVariant }
> = {
  unknown: { label: "No stated total", variant: "slate" },
  match: { label: "Reconciles", variant: "positive" },
  refund_adjusted: { label: "Refund-adjusted", variant: "slate" },
  mismatch: { label: "Needs review", variant: "warning" },
};

type ReconciliationPurchase = {
  statedTotal: number | null;
  expenseTotal: number;
  unpricedExpenseCount: number;
  reconciliation?: PurchaseReconciliation;
  postedRefundTotal?: number;
  financialReconciliation?: Pick<
    PurchaseOut["financialReconciliation"],
    "postedRefundTotal"
  >;
};

export const purchaseReconciliationStatus = (
  purchase: ReconciliationPurchase,
): PurchaseReconciliation =>
  purchase.reconciliation ??
  reconcilePurchase({
    ...purchase,
    postedRefundTotal:
      purchase.postedRefundTotal ??
      purchase.financialReconciliation?.postedRefundTotal ??
      0,
  });

/** The signed delta between the Expense total and the stated paperwork total. */
export const reconciliationDelta = (purchase: {
  statedTotal: number | null;
  expenseTotal: number;
}): number | null =>
  purchase.statedTotal === null
    ? null
    : purchase.expenseTotal - purchase.statedTotal;

export const ReconciliationBadge: FC<{
  purchase: ReconciliationPurchase;
}> = ({ purchase }) => {
  const status = purchaseReconciliationStatus(purchase);
  const delta = reconciliationDelta(purchase);

  const presentation = STATUS_PRESENTATION[status];
  return (
    <Badge variant={presentation.variant}>
      {(status === "mismatch" || status === "refund_adjusted") && delta !== null
        ? `${presentation.label} ${formatCurrency(delta)}`
        : presentation.label}
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
    {status === "refund_adjusted" &&
      "Posted refund evidence fully explains why the expenses are below the original stated total. The stated total remains the literal paperwork amount, and spend remains the expenses."}
    {status === "mismatch" &&
      "The expenses don't add up to what the purchase stated, and posted refund evidence doesn't fully explain the difference. Review the expenses, stated total, or settlement evidence."}
  </Description>
);

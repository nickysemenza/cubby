import { fieldValueOf } from "@cubby/schemas/field-envelope";
import type { PurchaseReconciliation } from "@cubby/schemas/purchase";
import { reconcilePurchase } from "@cubby/schemas/purchase";
import { useQueryClient } from "@tanstack/react-query";
import { type FC, useMemo } from "react";

import { fieldEnumOptions } from "~/entity/display/enum-field-display";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useEntityMetadata } from "~/entity/metadata";
import { formatCurrency } from "~/lib/number-format";
import { EnumPill } from "~/ui/primitives/enum-pill";

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
const STATUS_PRESENTATION = {
  // Covers both reconcilePurchase "unknown" cases: no stated total to compare
  // against, and no Expense lines to compare with.
  unknown: { label: "Nothing to reconcile" },
  match: { label: "Reconciles" },
  refund_adjusted: { label: "Refund-adjusted" },
  mismatch: { label: "Needs review" },
} satisfies Record<PurchaseReconciliation, { label: string }>;

type ReconciliationPurchase = {
  statedTotal: number | null;
  expenseTotal: number;
  expenseCount?: number;
  unpricedExpenseCount: number;
  reconciliation?: PurchaseReconciliation;
  postedRefundTotal?: number;
  financialReconciliation?: Pick<
    NonNullable<ReturnType<typeof financialReconciliationFor>>,
    "postedRefundTotal"
  >;
};

const purchaseReconciliationStatus = (
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
const reconciliationDelta = (purchase: {
  statedTotal: number | null;
  expenseTotal: number;
}): number | null =>
  purchase.statedTotal === null
    ? null
    : purchase.expenseTotal - purchase.statedTotal;

export const ReconciliationStatus: FC<{
  purchase: ReconciliationPurchase;
}> = ({ purchase }) => {
  const queryClient = useQueryClient();
  useEntityMetadata("purchase");
  const options = useMemo(
    () => fieldEnumOptions(queryClient, "purchase", "reconciliation"),
    [queryClient],
  );
  const status = purchaseReconciliationStatus(purchase);
  const delta = reconciliationDelta(purchase);

  const presentation = STATUS_PRESENTATION[status];
  const option = options.find((candidate) => candidate.value === status);
  return (
    <EnumPill
      optionRole={option?.role}
      glyph={option?.glyph}
      color={option?.color ?? "var(--slate)"}
    >
      {(status === "mismatch" || status === "refund_adjusted") && delta !== null
        ? `${presentation.label} ${formatCurrency(delta)}`
        : presentation.label}
    </EnumPill>
  );
};

type PurchaseOut = DetailRecordOf<"purchase">;

const financialReconciliationFor = (purchase: PurchaseOut) =>
  fieldValueOf(purchase.fields.financialReconciliation);

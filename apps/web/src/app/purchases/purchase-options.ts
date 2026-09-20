import type { PurchaseReconciliation } from "@cubby/schemas/purchase";

import {
  buildSelectOptions,
  colorizeSelectOptions,
} from "~/lib/select-options";

const reconciliationValues = [
  "match",
  "refund_adjusted",
  "mismatch",
  "unknown",
] as const;
const reconciliationLabels = {
  match: "Reconciles",
  refund_adjusted: "Refund-adjusted",
  mismatch: "Needs review",
  unknown: "No stated total",
} satisfies Record<PurchaseReconciliation, string>;
const reconciliationColors = {
  match: "var(--positive)",
  refund_adjusted: "var(--slate)",
  mismatch: "var(--warning)",
  unknown: "var(--slate)",
} satisfies Record<PurchaseReconciliation, string>;

export const purchaseReconciliationOptions = colorizeSelectOptions(
  buildSelectOptions(reconciliationValues, reconciliationLabels).map(
    (option) => {
      return { ...option, color: reconciliationColors[option.value] };
    },
  ),
);

const financialSettlementValues = [
  "unknown",
  "pending",
  "match",
  "mismatch",
] as const;
const financialSettlementLabels = {
  unknown: "No evidence",
  pending: "Pending",
  match: "Settled",
  mismatch: "Mismatch",
} satisfies Record<(typeof financialSettlementValues)[number], string>;

export const financialSettlementOptions = colorizeSelectOptions(
  buildSelectOptions(financialSettlementValues, financialSettlementLabels),
);

/** Table preset → exact server bounds. URL/MCP callers can send exact bounds. */
export function resolvePurchaseExpenseTotalFilter(preset: string | undefined) {
  if (preset === "gte500") return { expenseTotalMin: 500 };
  if (preset === "gte200") return { expenseTotalMin: 200 };
  if (preset === "gte100") return { expenseTotalMin: 100 };
  if (preset === "nonpositive") return { expenseTotalMax: 0 };
  return {};
}

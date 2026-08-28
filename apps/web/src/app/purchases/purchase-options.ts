import type { PurchaseReconciliation } from "@cubby/schemas/purchase";

import { buildSelectOptions } from "~/lib/select-options";

const reconciliationValues = [
  "match",
  "refund_adjusted",
  "mismatch",
  "unknown",
] as const;
const reconciliationLabels: Record<PurchaseReconciliation, string> = {
  match: "Reconciles",
  refund_adjusted: "Refund-adjusted",
  mismatch: "Needs review",
  unknown: "No stated total",
};

export const purchaseReconciliationOptions = buildSelectOptions(
  reconciliationValues,
  reconciliationLabels,
);

/** Table preset → exact server bounds. URL/MCP callers can send exact bounds. */
export function resolvePurchaseExpenseTotalFilter(preset: string | undefined): {
  expenseTotalMin?: number;
  expenseTotalMax?: number;
} {
  if (preset === "gte500") return { expenseTotalMin: 500 };
  if (preset === "gte200") return { expenseTotalMin: 200 };
  if (preset === "gte100") return { expenseTotalMin: 100 };
  if (preset === "nonpositive") return { expenseTotalMax: 0 };
  return {};
}

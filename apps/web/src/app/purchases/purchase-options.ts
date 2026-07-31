import type {
  PurchaseExpenseStatus,
  PurchaseReconciliation,
} from "@cubby/schemas/purchase";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

const expenseStatusValues = ["empty", "unpriced", "priced"] as const;
const expenseStatusLabels: Record<PurchaseExpenseStatus, string> = {
  empty: "No expenses",
  unpriced: "Has unpriced expenses",
  priced: "Fully priced",
};

/** Disjoint buckets, so selecting unpriced + priced means "has expenses". */
export const purchaseExpenseStatusOptions = buildSelectOptions(
  expenseStatusValues,
  expenseStatusLabels,
);

const reconciliationValues = ["match", "mismatch", "unknown"] as const;
const reconciliationLabels: Record<PurchaseReconciliation, string> = {
  match: "Reconciles",
  mismatch: "Off",
  unknown: "No stated total",
};

export const purchaseReconciliationOptions = buildSelectOptions(
  reconciliationValues,
  reconciliationLabels,
);

export const purchaseExpenseTotalOptions: FilterableComboboxItem[] = [
  { value: "gte500", label: "$500 and up" },
  { value: "gte200", label: "$200 and up" },
  { value: "gte100", label: "$100 and up" },
  { value: "nonpositive", label: "Non-positive (≤ $0)" },
];

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

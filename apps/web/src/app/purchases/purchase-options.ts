import type {
  PurchaseLineStatus,
  PurchaseReconciliation,
} from "@cubby/schemas/purchase";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

const lineStatusValues = ["empty", "unpriced", "priced"] as const;
const lineStatusLabels: Record<PurchaseLineStatus, string> = {
  empty: "No lines",
  unpriced: "Has unpriced lines",
  priced: "Fully priced",
};

/** Disjoint buckets, so selecting unpriced + priced means "has lines". */
export const purchaseLineStatusOptions = buildSelectOptions(
  lineStatusValues,
  lineStatusLabels,
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

export const purchaseLineTotalOptions: FilterableComboboxItem[] = [
  { value: "gte500", label: "$500 and up" },
  { value: "gte200", label: "$200 and up" },
  { value: "gte100", label: "$100 and up" },
  { value: "nonpositive", label: "Non-positive (≤ $0)" },
];

/** Table preset → exact server bounds. URL/MCP callers can send exact bounds. */
export function resolvePurchaseLineTotalFilter(preset: string | undefined): {
  expenseTotalMin?: number;
  expenseTotalMax?: number;
} {
  if (preset === "gte500") return { expenseTotalMin: 500 };
  if (preset === "gte200") return { expenseTotalMin: 200 };
  if (preset === "gte100") return { expenseTotalMin: 100 };
  if (preset === "nonpositive") return { expenseTotalMax: 0 };
  return {};
}

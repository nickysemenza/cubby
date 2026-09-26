import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Labels for `LedgerTransfer.classification`, the server-derived reading of
 * what a transfer represents (never a stored input — see
 * `ledgerTransferOut.classification`). Detail-page only today; add here
 * rather than the list so a future list column reuses the same roster.
 */
export const ledgerTransferClassificationOptions: FilterableComboboxItem[] = [
  { value: "internal_move", label: "Internal move", color: "var(--slate)" },
  { value: "contribution", label: "Contribution", color: "var(--positive)" },
  {
    value: "household_distribution",
    label: "Household distribution",
    color: "var(--primary)",
  },
  { value: "reimbursement", label: "Reimbursement", color: "var(--warning)" },
];

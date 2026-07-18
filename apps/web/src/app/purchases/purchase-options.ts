import {
  purchaseCategoryValues,
  purchaserValues,
} from "@cubby/schemas/project";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

/** Human labels for the fixed purchase-category enum. */
export const purchaseCategoryLabels: Record<
  (typeof purchaseCategoryValues)[number],
  string
> = {
  materials: "Materials",
  tools: "Tools",
  services: "Services",
};

/** `{value,label}` options for the category filter/inline-edit select. */
export const purchaseCategoryOptions = buildSelectOptions(
  purchaseCategoryValues,
  purchaseCategoryLabels,
);

/** Human labels for the fixed purchaser enum. */
export const purchaserLabels: Record<(typeof purchaserValues)[number], string> =
  {
    nicky: "Nicky",
    rebecca: "Rebecca",
    both: "Both",
  };

/** `{value,label}` options for the purchaser filter/inline-edit select. */
export const purchaserOptions = buildSelectOptions(
  purchaserValues,
  purchaserLabels,
);

/** `{value,label}` options for the "future" (planned vs. made) filter. */
export const futureFilterOptions: FilterableComboboxItem[] = [
  { value: "true", label: "Planned" },
  { value: "false", label: "Already made" },
];

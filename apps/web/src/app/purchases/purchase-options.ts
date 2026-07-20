import { costTypeValues } from "@cubby/schemas/project";
import type { FilterableComboboxItem } from "~/components/ui/combobox";
import { buildSelectOptions } from "~/lib/select-options";

/** Human labels for the fixed cost-type enum. */
export const costTypeLabels: Record<(typeof costTypeValues)[number], string> = {
  materials: "Materials",
  tools: "Tools",
  services: "Services",
};

/** `{value,label}` options for the cost-type filter/inline-edit select. */
export const costTypeOptions = buildSelectOptions(
  costTypeValues,
  costTypeLabels,
);

/** `{value,label}` options for the "future" (planned vs. made) filter. */
export const futureFilterOptions: FilterableComboboxItem[] = [
  { value: "true", label: "Planned" },
  { value: "false", label: "Already made" },
];

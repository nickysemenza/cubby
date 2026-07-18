import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Builds `{value,label}` options for a filter/inline-edit select from a fixed
 * enum's values plus a label lookup. Shared by task/purchase status/category
 * option lists so the mapping isn't hand-rolled per enum.
 */
export function buildSelectOptions<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): FilterableComboboxItem[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

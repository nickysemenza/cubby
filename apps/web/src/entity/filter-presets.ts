import type { FilterPatch } from "~/entity/filters";

/**
 * The expander for a range descriptor whose presets are declared as data
 * (`filters.descriptors[].options[].expand`). An unknown preset expands to
 * nothing, like every hand-written expander did.
 */
export const presetExpand = (
  table: Readonly<Record<string, FilterPatch>>,
): ((value: string) => FilterPatch) => {
  const presets = new Map(Object.entries(table));
  return (value) => presets.get(value) ?? {};
};

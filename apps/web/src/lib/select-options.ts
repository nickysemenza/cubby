import { colorizeEnumOptions } from "@cubby/shared/enum-palette";

import type { FilterableComboboxItem } from "~/ui/primitives/combobox";

/** Shared defaults also cover web-only editor sentinels. */
export function colorizeSelectOptions<T extends FilterableComboboxItem>(
  options: readonly T[],
): Array<T & { color: string }> {
  return colorizeEnumOptions(options);
}

/** Default dot inks for a boolean whose `true` really is the good outcome. */
const DEFAULT_BOOLEAN_COLORS = {
  true: "var(--positive)",
  false: "var(--slate)",
} as const;

/**
 * Roster for a stored boolean — the single source of its two labels AND their
 * tones, shared by the table column and any detail surface that renders the
 * same field.
 *
 * Tones are a parameter, not a constant, because "true" is not always the good
 * outcome. `FinancialAccount.provisional` is the counter-example that proves it:
 * a provisional account is the *unresolved* one, so it reads amber and `Known`
 * reads green — the inverse of the default. Hardcoding positive/slate inside the
 * column factory made the list disagree with the detail page on that field, which
 * is the drift this whole change exists to remove.
 */
export function booleanCellOptions(
  labels: { true: string; false: string },
  colors: { true: string; false: string } = DEFAULT_BOOLEAN_COLORS,
): FilterableComboboxItem[] {
  return [
    { value: "true", label: labels.true, color: colors.true },
    { value: "false", label: labels.false, color: colors.false },
  ];
}

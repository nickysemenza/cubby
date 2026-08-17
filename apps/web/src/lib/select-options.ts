import type { FilterableComboboxItem } from "~/components/ui/combobox";

/**
 * Builds `{value,label}` options for a filter/inline-edit select from a fixed
 * enum's values plus a label lookup. Shared by task/expense status/category
 * option lists so the mapping isn't hand-rolled per enum.
 */
export function buildSelectOptions<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): FilterableComboboxItem[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

/**
 * Roster for a *presence* column — one that reports whether some other field is
 * filled ("Has UPC"), rather than storing a decision of its own.
 *
 * Both states get a label, which is the whole point. These columns used to
 * render `x ? "Has UPC" : <NoneValue />`, so a product whose UPC was genuinely
 * absent looked identical to one whose row simply had nothing to say — and `—`
 * is the marker this codebase reserves for "we don't know". The absent state is
 * a known fact, so it reads as one, in the quiet ink rather than the accent.
 *
 * Presence is derived, never written, so these carry no editor.
 */
export function presenceCellOptions(noun: string): FilterableComboboxItem[] {
  return [
    { value: "yes", label: `Has ${noun}`, color: "var(--slate)" },
    { value: "no", label: `No ${noun}`, color: "var(--muted-foreground)" },
  ];
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

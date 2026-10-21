import type { PickerOption } from "~/ui/combobox/picker-option";

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
): PickerOption[] {
  return [
    {
      value: "true",
      label: labels.true,
      color: colors.true,
      role: "status",
      glyph: { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
    },
    {
      value: "false",
      label: labels.false,
      color: colors.false,
      role: "status",
      glyph: { phosphor: "MinusCircle", sfSymbol: "minus.circle" },
    },
  ];
}

/** Capture-only sentinel, stripped before validating a stored Expense. */
export const expenseLineAutoOption = {
  value: "auto",
  label: "Decide from receipt evidence",
  role: "category",
  color: "var(--brand-domain-finance)",
  glyph: { phosphor: "Sparkle", sfSymbol: "sparkles" },
} as const;

import type { FilterableComboboxItem } from "~/components/ui/combobox";

const CATEGORICAL_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

function semanticOptionColor(value: string): string | undefined {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    ["active", "available", "verified", "growing", "match", "matched"].includes(
      normalized,
    )
  )
    return "var(--positive)";
  if (normalized === "pending" || normalized.startsWith("pending_"))
    return "var(--warning)";
  if (normalized === "paused" || normalized.startsWith("paused_"))
    return "var(--warning)";
  if (["failed", "missing", "mismatch", "mismatched"].includes(normalized))
    return "var(--destructive)";
  if (
    [
      "__none__",
      "none",
      "unknown",
      "unverified",
      "disabled",
      "finished",
    ].includes(normalized)
  )
    return "var(--slate)";
  if (normalized === "planned") return "var(--chart-4)";
  return undefined;
}

/** Complete an enum roster with semantic or stable declaration-order colors. */
export function colorizeSelectOptions<T extends FilterableComboboxItem>(
  options: readonly T[],
): Array<T & { color: string }> {
  let categoricalIndex = 0;
  return options.map((option) => {
    if (option.color !== undefined) return { ...option, color: option.color };
    const semantic = semanticOptionColor(option.value);
    if (semantic !== undefined) return { ...option, color: semantic };
    const color =
      CATEGORICAL_COLORS[categoricalIndex % CATEGORICAL_COLORS.length]!;
    categoricalIndex += 1;
    return { ...option, color };
  });
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

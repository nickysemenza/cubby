/** Adaptive roles from design-tokens/tokens.json, shared by compiled web and Apple rosters. */
const CATEGORY_COLORS = [
  "var(--brand-domain-house)",
  "var(--brand-domain-plan)",
  "var(--brand-domain-cook)",
  "var(--brand-domain-finance)",
  "var(--brand-domain-pantry)",
] as const;

const LEGACY_COLORS = new Map([
  ["var(--chart-1)", "var(--brand-domain-house)"],
  ["var(--chart-2)", "var(--brand-domain-pantry)"],
  ["var(--chart-3)", "var(--brand-domain-house)"],
  ["var(--chart-4)", "var(--brand-domain-plan)"],
  ["var(--chart-5)", "var(--brand-domain-cook)"],
  ["var(--chart-6)", "var(--brand-domain-finance)"],
  ["var(--chart-positive)", "var(--positive)"],
  ["var(--chart-negative)", "var(--destructive)"],
  ["var(--chart-neutral)", "var(--slate)"],
  ["var(--muted-foreground)", "var(--slate)"],
  ["var(--primary)", "var(--brand-domain-house)"],
  ["var(--info)", "var(--brand-domain-house)"],
  ["var(--plum)", "var(--brand-domain-plan)"],
]);

function semanticColor(value: string): string | undefined {
  const key = value.toLowerCase().replace(/[\s-]+/g, "_");
  if (
    [
      "active",
      "available",
      "verified",
      "confirmed",
      "growing",
      "match",
      "matched",
      "present",
      "recorded",
      "posted",
      "completed",
      "done",
      "succeeded",
      "acquired",
      "yes",
      "mapped",
    ].includes(key)
  )
    return "var(--positive)";
  if (
    [
      "unknown",
      "unclassified",
      "unspecified",
      "unverified",
      "pending",
      "paused",
      "partial",
      "needs_review",
      "maybe",
      "ambiguous",
      "later",
      "bare",
    ].includes(key) ||
    key.startsWith("pending_") ||
    key.startsWith("paused_")
  )
    return "var(--warning)";
  if (
    [
      "failed",
      "missing",
      "mismatch",
      "mismatched",
      "blocked",
      "void",
      "no",
    ].includes(key) ||
    key.endsWith("_failed") ||
    key.endsWith("_mismatch")
  )
    return "var(--destructive)";
  if (
    [
      "__none__",
      "none",
      "disabled",
      "finished",
      "not_expected",
      "not_applicable",
      "not_started",
      "unassigned",
      "other",
    ].includes(key)
  )
    return "var(--slate)";
  if (["expected", "required", "running", "in_progress"].includes(key))
    return "var(--brand-domain-house)";
  if (["planned", "planning"].includes(key)) return "var(--brand-domain-plan)";
  return undefined;
}

/** Complete once in declaration order, before any surface filters the choices. */
export function colorizeEnumOptions<
  T extends { value: string; color?: string },
>(options: readonly T[]): Array<T & { color: string }> {
  let index = 0;
  return options.map((option) => {
    const explicit = option.color;
    const color =
      explicit !== undefined
        ? (LEGACY_COLORS.get(explicit) ?? explicit)
        : (semanticColor(option.value) ??
          CATEGORY_COLORS[index++ % CATEGORY_COLORS.length]!);
    return { ...option, color };
  });
}

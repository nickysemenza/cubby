/** Adaptive roles from design-tokens/tokens.json, shared by compiled web and Apple rosters. */
const CATEGORY_COLORS = [
  "var(--category-1)",
  "var(--category-2)",
  "var(--category-3)",
  "var(--category-4)",
  "var(--category-5)",
  "var(--category-6)",
  "var(--category-7)",
  "var(--category-8)",
] as const;

const LEGACY_COLORS = new Map([
  ["var(--chart-1)", "var(--category-1)"],
  ["var(--chart-2)", "var(--category-3)"],
  ["var(--chart-3)", "var(--category-1)"],
  ["var(--chart-4)", "var(--category-5)"],
  ["var(--chart-5)", "var(--category-4)"],
  ["var(--chart-6)", "var(--category-2)"],
  ["var(--chart-positive)", "var(--positive)"],
  ["var(--chart-negative)", "var(--destructive)"],
  ["var(--chart-neutral)", "var(--neutral-status)"],
  ["var(--muted-foreground)", "var(--neutral-status)"],
  ["var(--primary)", "var(--info)"],
  ["var(--plum)", "var(--category-5)"],
]);

/**
 * Condition colors. An option whose color is one of these reads as a state
 * (filled tint + glyph); anything else is a category (neutral chip).
 */
const CONDITION_COLORS = new Set([
  "var(--positive)",
  "var(--warning)",
  "var(--destructive)",
  "var(--info)",
  "var(--neutral-status)",
]);

/** A roster's visual role: `status` options are states, `category` options are kinds. */
export type EnumRole = "status" | "category";

/** One glyph for both clients: a Phosphor component name and an SF Symbol. */
export interface EnumIcon {
  phosphor: string;
  sfSymbol: string;
}

const STATUS_ICONS: Record<string, EnumIcon> = {
  "var(--positive)": { phosphor: "CheckCircle", sfSymbol: "checkmark.circle.fill" },
  "var(--warning)": { phosphor: "Clock", sfSymbol: "clock" },
  "var(--destructive)": { phosphor: "XCircle", sfSymbol: "xmark.circle.fill" },
  "var(--info)": { phosphor: "CircleHalf", sfSymbol: "circle.lefthalf.filled" },
  "var(--neutral-status)": { phosphor: "CircleDashed", sfSymbol: "circle.dashed" },
};

const VALUE_ICONS: Record<string, EnumIcon> = {
  blocked: { phosphor: "Prohibit", sfSymbol: "nosign" },
  paused: { phosphor: "PauseCircle", sfSymbol: "pause.circle" },
  planned: { phosphor: "CalendarDots", sfSymbol: "calendar" },
  planning: { phosphor: "CalendarDots", sfSymbol: "calendar" },
  waiting: { phosphor: "Hourglass", sfSymbol: "hourglass" },
};

function valueKey(value: string) {
  return value.toLowerCase().replace(/[\s-]+/g, "_");
}

function semanticColor(value: string): string | undefined {
  const key = valueKey(value);
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
      "waiting",
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
      "planned",
      "planning",
    ].includes(key)
  )
    return "var(--neutral-status)";
  if (["expected", "required", "running", "in_progress"].includes(key))
    return "var(--info)";
  return undefined;
}

type EnumOptionInput = {
  value: string;
  color?: string;
  role?: EnumRole | null;
  glyph?: EnumIcon;
};

/**
 * Complete once in declaration order, before any surface filters the choices.
 *
 * A roster is `status` when every option carries a condition color (declared
 * or inferred from its value); otherwise it is `category`. Category rosters
 * ignore the legacy blanket `slate` and cycle the category palette, so kinds
 * stay distinguishable. Re-running on completed options is a no-op.
 */
export function colorizeEnumOptions<T extends EnumOptionInput>(
  options: readonly T[],
  rosterRole?: EnumRole | null,
): Array<T & { color: string; role: EnumRole; glyph?: EnumIcon }> {
  const resolved = options.map((option) => {
    const explicit =
      option.color === undefined
        ? undefined
        : (LEGACY_COLORS.get(option.color) ?? option.color);
    return explicit === "var(--slate)" ? undefined : explicit;
  });
  const semantic = options.map(
    (option, index) => resolved[index] ?? semanticColor(option.value),
  );
  const inferredRole: EnumRole =
    options.length > 0 &&
    semantic.every((color) => color !== undefined && CONDITION_COLORS.has(color))
      ? "status"
      : "category";
  const role = rosterRole ?? options[0]?.role ?? inferredRole;
  let index = 0;
  return options.map((option, position) => {
    const color =
      role === "status"
        ? (semantic[position] ?? "var(--neutral-status)")
        : (semantic[position] ??
          CATEGORY_COLORS[index++ % CATEGORY_COLORS.length]!);
    const glyph =
      option.glyph ??
      (role === "status"
        ? (VALUE_ICONS[valueKey(option.value)] ?? STATUS_ICONS[color] ?? null)
        : null);
    // Omitted when absent: the compiled model ships in a budgeted bundle.
    return glyph
      ? { ...option, color, role, glyph }
      : { ...option, color, role };
  });
}

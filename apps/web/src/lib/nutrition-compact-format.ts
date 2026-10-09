import type { MeasureEstimate } from "@cubby/schemas/nutrition";

export type CompactEstimateUnit = "kcal" | "macro";

/**
 * A figure in a compact nutrition cell: kcal rounds half-up to a whole number,
 * a macro to one decimal, both grouped en-US. Matches the Rust formatter
 * native uses (`golden-vectors/display-format.json`); `+ EPSILON` nudges a
 * binary-just-below half over the line exactly as Rust does.
 */
export const compactNumberText = (
  value: number,
  unit: CompactEstimateUnit,
): string => {
  const rounded =
    unit === "kcal"
      ? Math.floor(value + 0.5)
      : Math.floor((value + Number.EPSILON) * 10 + 0.5) / 10;
  const [int = "", frac] = String(Object.is(rounded, -0) ? 0 : rounded).split(
    ".",
  );
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
};

/**
 * The one-line macro cell: a range joins with an en dash, a partial estimate
 * ends in `+`, and anything unavailable or pending is `—`.
 */
export const compactEstimateText = (
  estimate: MeasureEstimate,
  unit: CompactEstimateUnit,
): string => {
  if (estimate.status !== "complete" && estimate.status !== "partial")
    return "—";
  const { lower, upper } = estimate;
  const text =
    upper != null && upper !== lower
      ? `${compactNumberText(lower, unit)}–${compactNumberText(upper, unit)}`
      : compactNumberText(lower, unit);
  return estimate.status === "partial" ? `${text}+` : text;
};

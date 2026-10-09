import type { MeasureEstimate } from "@cubby/schemas/nutrition";

import { wasmFormat } from "~/lib/wasm";

// Kept apart from `nutrition-format` (also imported by the calendar Durable
// Object): this module needs the WASM formatters, which workerd test builds
// without the web SSR redirect cannot instantiate.

export type CompactEstimateUnit = "kcal" | "macro";

/**
 * A figure in a compact nutrition cell: kcal rounds half-up to a whole number,
 * a macro to one decimal, both grouped en-US. Formatted by the Rust
 * implementation native shares (`golden-vectors/display-format.json`).
 */
export const compactNumberText = (
  value: number,
  unit: CompactEstimateUnit,
): string => wasmFormat.format_compact_number(value, unit);

/**
 * The one-line macro cell: a range joins with an en dash, a partial estimate
 * ends in `+`, and anything unavailable or pending is `—`.
 */
export const compactEstimateText = (
  estimate: MeasureEstimate,
  unit: CompactEstimateUnit,
): string => wasmFormat.format_compact_estimate(estimate, unit);

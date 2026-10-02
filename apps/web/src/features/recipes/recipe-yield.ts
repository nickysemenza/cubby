/**
 * Format a recipe yield for display, e.g. "18 servings". A unitless yield
 * carries the parser's "whole" sentinel (a bare count); drop it so "18 whole"
 * renders as just "18".
 *
 * Its own module because both `recipe-utils` (wasm-bound) and
 * `recipe-export-markdown` (deliberately wasm-free) need it, and this way there
 * is one copy instead of the three that had accumulated.
 *
 * Note this is NOT `wasm.format_amount`: that pluralizes and uses glyph
 * fractions ("2 cups", "1/2 cup"), which is a different — arguably better —
 * rendering than the yields currently show. Switching is a visible text change
 * across ~18 surfaces, so it's a deliberate follow-up, not a dedup.
 */
export const formatYield = (y: {
  value: number;
  // Nullable because `buildRecipeKicker`'s input genuinely has an optional
  // unit; a missing one means the same thing as the "whole" sentinel.
  unit?: string | null;
}): string =>
  !y.unit || y.unit === "whole" ? `${y.value}` : `${y.value} ${y.unit}`;

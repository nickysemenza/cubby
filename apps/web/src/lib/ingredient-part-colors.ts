/**
 * One underline color per part of the "amount name modifier" display format.
 * The colored underline identifies *which* section a span/diff belongs to —
 * the only section label, replacing inline text like "mod:". Colors live as CSS
 * tokens (styles.css) so every ingredient surface — parse
 * drift, the grammar decomposition carve, the rich-text line — stays in sync.
 *
 * Keys match the `WField` string union (`"amount" | "name" | "modifier"`) the
 * wasm `decompose_ingredient` export emits, so a segment's `field` indexes this
 * map directly.
 */
export type IngredientPart = "amount" | "name" | "modifier";

export const INGREDIENT_PART_COLOR = {
  amount: "var(--ingredient-amount)",
  name: "var(--ingredient-name)",
  modifier: "var(--ingredient-modifier)",
} satisfies Record<IngredientPart, string>;

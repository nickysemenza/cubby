import type { Amount } from "@cubby/schemas/codec";
import type { IngItem } from "./types";

/** A draft amount, where either part may be blank while the row is half-typed. */
type DraftAmount = {
  value?: number | null;
  unit?: string | null;
  upperValue?: number | null;
};

/** True when neither part of an amount is filled — the "no amount" case. */
const isBlankAmount = (a: DraftAmount): boolean =>
  a.value == null && !a.unit?.trim();

/**
 * Drop fully-blank amounts (an amount-less ingredient like frying oil) and narrow
 * the survivors to the strict Amount shape, carrying the range upper bound when
 * present. The form's draftAmount refine guarantees a non-blank amount has both
 * parts (and a valid upper > value), so the assertions are safe here. Including
 * upperValue also makes a range edit register as a change in the comparison below.
 */
export const normalizeAmounts = (amounts: DraftAmount[]): Amount[] =>
  amounts
    .filter((a) => !isBlankAmount(a))
    .map((a) => ({
      value: a.value as number,
      unit: a.unit as string,
      ...(a.upperValue != null ? { upperValue: a.upperValue } : {}),
    }));

/**
 * Normalize an ingredient for comparison by extracting the comparable properties.
 * Used to detect changes between original and updated recipe ingredients.
 */
const normalizeIngredientForComparison = (ing: IngItem) => ({
  id: ing.id,
  type: ing.type,
  ingredientId:
    ing.type === "ingredient" && ing.ingredient ? ing.ingredient.id : null,
  recipeId: ing.type === "recipe" && ing.recipe ? ing.recipe.id : null,
  // Strip blank amounts so a loaded amount-less ingredient (DB `[]` → blank form
  // slot) compares equal and doesn't read as a spurious change.
  amounts: normalizeAmounts(ing.amounts),
  // modifier is now user-editable (e.g. "for frying" on an amount-less oil, which
  // drives the absorbed-oil estimate), so it must be compared or a modifier-only
  // edit is silently dropped. Coerce undefined/"" to null so the shapes match.
  modifier: ing.modifier?.trim() || null,
});

/**
 * Compare two arrays of ingredients to detect if they have changed.
 * Uses JSON.stringify for deep comparison after normalization.
 */
export const haveIngredientsChanged = (
  original: IngItem[],
  updated: IngItem[],
): boolean => {
  return (
    JSON.stringify(original.map(normalizeIngredientForComparison)) !==
    JSON.stringify(updated.map(normalizeIngredientForComparison))
  );
};

/**
 * Compare two arrays of instructions to detect if they have changed.
 * Uses JSON.stringify for deep comparison.
 */
export const haveInstructionsChanged = (
  original: Array<{ id?: string; instruction: string }>,
  updated: Array<{ id?: string; instruction: string }>,
): boolean => {
  return JSON.stringify(original) !== JSON.stringify(updated);
};

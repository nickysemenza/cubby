// Server-safe ingredient helpers (no client/DOM imports), so the recipe costing
// rollup can run on the server as well as the client.

// Marks an ingredient as the frying medium (oil/fat the food is cooked in).
// "fry" catches frying/deep-fry/stir-fry; "fried" catches fried/deep-fried/
// pan-fried. We check the parser-derived `modifier` and `rawLine` as well as the
// name, since the convention is an oil named normally with a "for frying"
// modifier (mirrors the existing "… for the pan" pattern). The caller decides
// whether it's *unmeasured* (no amount) before treating it as absorbed oil.
const FRYING_TERMS = ["fry", "fried"];

export const isFryingMediumIngredient = (
  ingredient: { modifier?: string | null; rawLine?: string | null },
  name: string,
): boolean =>
  [ingredient.modifier, ingredient.rawLine, name].some((field) => {
    if (!field) return false;
    const s = field.toLowerCase();
    return FRYING_TERMS.some((t) => s.includes(t));
  });

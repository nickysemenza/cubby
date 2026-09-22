import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";

import type { BaseKind, ConversionCoverage } from "~/lib/conversion-coverage";
import type { RecipeCosting } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";

/**
 * The single highest-leverage fix we suggest for an ingredient whose totals are
 * incomplete.
 *
 * Ordering reflects leverage: linking a product (and a USDA food) unlocks the
 * most at once, so it ranks above adding individual mappings. The two price
 * variants are unit-aware — a per-each price costs a *count* line ("2 zucchini")
 * directly, but can't reach a *weight/volume* line ("1 tsp cumin"), which needs
 * a purchase mapping that bridges weight<->money (e.g. "4 oz = $5.99").
 */
export type IngredientTotalsGapKind =
  | "no-product"
  | "link-usda"
  | "set-per-item-price"
  | "add-purchase-mapping"
  | "add-weight-mapping"
  | "add-volume-mapping";

type RecipeTotalsGapKind =
  | IngredientTotalsGapKind
  | "set-subrecipe-amount"
  | "set-subrecipe-yield"
  | "fix-subrecipe-totals";

/** What kind of measurement the recipe line uses, for tailoring price copy. */
export type LineKind = "count" | "weight" | "volume";

type MissingTotals = {
  price: boolean;
  weight: boolean;
  nutrients: boolean;
  volume: boolean;
};

export type RecipeTotalsGap =
  | {
      source: "ingredient";
      ingredientId: string;
      ingredientShortcode: string;
      name: string;
      /** Single-product -> deep-link target; null routes to the ingredient hub. */
      productId: string | null;
      productShortcode: string | null;
      /** The recipe line's primary unit (drives the example in the suggestion). */
      lineUnit: string | null;
      lineKind: LineKind;
      /** Which totals measures are incomplete for this ingredient. */
      missing: MissingTotals;
      /** The prioritized fix to suggest. */
      kind: IngredientTotalsGapKind;
    }
  | {
      source: "recipe";
      /** The parent section-ingredient row id. */
      rowId: string;
      /** The sub-recipe being referenced. */
      recipeId: string;
      /** The sub-recipe's public id, for its detail-route deep-link. */
      recipeShortcode: string;
      name: string;
      lineUnit: string | null;
      lineKind: LineKind;
      /** Which totals measures are incomplete for this sub-recipe row. */
      missing: MissingTotals;
      /** The prioritized fix to suggest. */
      kind:
        | "set-subrecipe-amount"
        | "set-subrecipe-yield"
        | "fix-subrecipe-totals";
    };

// Priority rank for sorting — lower sorts first (highest leverage on top).
const KIND_RANK = {
  "no-product": 0,
  "set-subrecipe-amount": 0,
  "set-subrecipe-yield": 0,
  "fix-subrecipe-totals": 1,
  "link-usda": 1,
  "set-per-item-price": 2,
  "add-purchase-mapping": 2,
  "add-weight-mapping": 3,
  // Volume is never a recipe-totals blocker; it only surfaces in the global
  // workbench, so its sort rank is nominal.
  "add-volume-mapping": 4,
} satisfies Record<RecipeTotalsGapKind, number>;

/**
 * Classify a recipe line's unit into the kind that drives the price suggestion.
 * The engine's `amount_kind` has no "count" bucket — discrete units like "each"
 * or "clove" fall through to "other"/length/etc., which we treat as count.
 */
const classifyLine = (unit: string | null): LineKind => {
  if (!unit) return "count";
  try {
    const k = wasm.amount_kind({ value: 1, unit });
    if (k === "weight") return "weight";
    if (k === "volume") return "volume";
  } catch {
    // SILENT: unknown unit -> treat as a count (the common "2 eggs" /
    // "1 zucchini" case); the "count" return below already covers this.
  }
  return "count";
};

interface GapAccumulator {
  name: string;
  ingredientShortcode: string;
  productId: string | null;
  productShortcode: string | null;
  lineUnit: string | null;
  lineKind: LineKind;
  products: IngredientWithFoodLeanOut["product"];
  // `volume` is always false on the recipe path — volume isn't a totals blocker
  // for a specific line; it's a global-workbench-only signal.
  missing: MissingTotals;
}

type CostingRow = RecipeCosting["rows"][number];
type CostingRecipeRow = Extract<CostingRow, { type: "recipe" }>;
type CostingIngredientRow = Exclude<CostingRow, CostingRecipeRow>;

const missingTotalsFor = (row: CostingRow): MissingTotals => ({
  price: row.totalsMissing.price,
  weight: row.totalsMissing.weight,
  nutrients: row.totalsMissing.nutrients,
  volume: false,
});

const recipeGapFor = (
  row: CostingRecipeRow,
  missing: MissingTotals,
): RecipeTotalsGap | null => {
  if (!missing.price && !missing.weight && !missing.nutrients) return null;
  const lineUnit = row.amounts[0]?.unit ?? null;
  const kind =
    row.amounts.length === 0
      ? "set-subrecipe-amount"
      : !row.recipe.yield
        ? "set-subrecipe-yield"
        : "fix-subrecipe-totals";
  return {
    source: "recipe",
    rowId: row.id,
    recipeId: row.recipe.id,
    recipeShortcode: row.recipe.id,
    name: row.recipe.name,
    lineUnit,
    lineKind: classifyLine(lineUnit),
    missing,
    kind,
  };
};

const accumulateIngredientGap = (
  row: CostingIngredientRow,
  missing: MissingTotals,
  ingMap: Record<string, IngredientWithFoodLeanOut>,
  byIngredientId: Map<string, GapAccumulator>,
) => {
  if (row.amounts.length === 0) return;
  if (!missing.price && !missing.weight) return;

  const id = row.ingredient.id;
  const existing = byIngredientId.get(id);
  if (existing) {
    existing.missing.price ||= missing.price;
    existing.missing.weight ||= missing.weight;
    existing.missing.nutrients ||= missing.nutrients;
    return;
  }

  const products = ingMap[id]?.product ?? [];
  const lineUnit = row.amounts[0]?.unit ?? null;
  byIngredientId.set(id, {
    name: row.ingredient.name,
    ingredientShortcode: row.ingredient.id,
    productId: products.length === 1 ? products[0]!.id : null,
    productShortcode: products.length === 1 ? products[0]!.id : null,
    lineUnit,
    lineKind: classifyLine(lineUnit),
    products,
    missing,
  });
};

const ingredientGapFor = (
  ingredientId: string,
  acc: GapAccumulator,
): RecipeTotalsGap | null => {
  const kind = classifyKind(acc);
  if (kind === "done" || kind === "add-volume-mapping") return null;
  return {
    source: "ingredient",
    ingredientId,
    ingredientShortcode: acc.ingredientShortcode,
    name: acc.name,
    productId: acc.productId,
    productShortcode: acc.productShortcode,
    lineUnit: acc.lineUnit,
    lineKind: acc.lineKind,
    missing: acc.missing,
    kind,
  };
};

/**
 * The shared classifier inputs — just the signals the fix decision needs, so the
 * per-recipe path (deriveRecipeTotalsGaps) and the global workbench path
 * (classifyIngredientFix) share one body. `GapAccumulator` is a structural
 * supertype, so it passes straight through.
 */
interface FixInputs {
  products: IngredientWithFoodLeanOut["product"];
  missing: MissingTotals;
  lineKind: LineKind;
}

const classifyKind = (acc: FixInputs): IngredientTotalsGapKind | "done" => {
  if (acc.products.length === 0) return "no-product";

  // A product is USDA-associated if it carries (or intends to carry) food data:
  // resolved `food`, or an fdc_id/barcode link whose lookup may be transiently
  // missing — or a label nutrition override, which supersedes USDA outright.
  const usdaLinked = acc.products.some(
    (p) =>
      p.food != null ||
      p.fdc_id != null ||
      p.primaryGtin != null ||
      p.labelNutrition != null,
  );
  const hasPrice = acc.products.some((p) => p.price != null);

  // Weight missing with no USDA link -> linking adds portion (+ nutrient)
  // conversions out of the box, the single biggest win.
  if (acc.missing.weight && !usdaLinked) return "link-usda";

  if (acc.missing.price) {
    // A per-each price can't cost a weight/volume line; it needs a purchase
    // mapping that bridges weight<->money. Same when a count line already has a
    // price but still can't resolve (unit mismatch) — a bridging mapping helps.
    if (acc.lineKind === "weight" || acc.lineKind === "volume") {
      return "add-purchase-mapping";
    }
    return hasPrice ? "add-purchase-mapping" : "set-per-item-price";
  }

  // Price resolved. Name the actually-missing measure rather than assuming
  // weight: a direct weight mapping when weight is unreachable, else a volume
  // mapping when an applicable volume is missing. Nothing measurable left (only
  // nutrients, or volume that's N/A) -> "done": no user-actionable totals fix.
  if (acc.missing.weight) return "add-weight-mapping";
  if (acc.missing.volume) return "add-volume-mapping";
  return "done";
};

/**
 * The global (non-recipe) twin of {@link classifyKind}: the single
 * highest-leverage fix for an ingredient, graded from its products' aggregate
 * conversion coverage instead of a specific recipe line. `"done"` means the
 * coverage graph is complete — nothing left to suggest. Used by the enrichment
 * workbench, which has no recipe context, only the ingredient's own products.
 *
 * Reads `coverage.covered` (not "has a price"): an islanded per-each price on a
 * weight-used food has money present but unreachable from a measure, so it's
 * still a gap (add-weight-mapping), exactly as the per-recipe path treats it.
 */
export const classifyIngredientFix = (input: {
  products: IngredientWithFoodLeanOut["product"];
  coverage: ConversionCoverage;
  /** Kinds graded against (gradedKinds) — an N/A volume is excluded here. */
  applicable: readonly BaseKind[];
  sampleLineKind: LineKind;
}): IngredientTotalsGapKind | "done" => {
  if (input.products.length === 0) return "no-product";
  if (input.coverage.tier === "complete") return "done";

  const covered = input.coverage.covered;
  // Only treat volume as a gap when it's applicable to this ingredient — a count
  // item the user opted out of (naKinds) shouldn't be told to "Add volume".
  const volumeApplicable = input.applicable.includes("volume");
  return classifyKind({
    products: input.products,
    missing: {
      price: !covered.has("money"),
      weight: !covered.has("weight"),
      nutrients: !covered.has("calories"),
      volume: volumeApplicable && !covered.has("volume"),
    },
    lineKind: input.sampleLineKind,
  });
};

/**
 * Derive the prioritized list of fixes for a recipe's incomplete totals. Walks
 * the engine's per-row results once (the reliable id-bearing signal), dedupes
 * ingredient rows by ingredient, and keeps sub-recipe rows as their own blockers
 * because their fixes live on recipes rather than products/ingredients.
 *
 * Ingredient rows only return price/weight blockers; a nutrient-only miss on an
 * already-linked product isn't user-actionable here. Sub-recipe rows do return
 * nutrient-only misses because the child recipe's own totals popover can explain
 * the underlying ingredient fixes.
 */
export const deriveRecipeTotalsGaps = (
  costing: RecipeCosting,
  ingMap: Record<string, IngredientWithFoodLeanOut>,
): RecipeTotalsGap[] => {
  const byIngredientId = new Map<string, GapAccumulator>();
  const recipeGaps: RecipeTotalsGap[] = [];

  for (const row of costing.rows) {
    const missing = missingTotalsFor(row);

    if (row.type === "recipe") {
      const gap = recipeGapFor(row, missing);
      if (gap) recipeGaps.push(gap);
      continue;
    }

    accumulateIngredientGap(row, missing, ingMap, byIngredientId);
  }

  const gaps: RecipeTotalsGap[] = [...recipeGaps];
  for (const [ingredientId, acc] of byIngredientId) {
    const gap = ingredientGapFor(ingredientId, acc);
    if (gap) gaps.push(gap);
  }

  // Highest-leverage fixes first; ties keep input order (stable name grouping).
  return gaps.sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
};

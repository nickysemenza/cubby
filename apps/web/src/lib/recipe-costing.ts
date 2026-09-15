import type {
  AmountKind,
  WAmount,
  WAvailabilityInput,
  WAvailabilityResult,
  WCostingInput,
  WCostingRow,
  WIngredientUsage,
  WMeasureResult,
  WNeedsInput,
  WNeedsResult,
  WNutrientsResult,
  WProductInput,
  WRecipeCosting,
  WRowResult,
} from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type {
  NutritionEstimate,
  NutritionTotals,
} from "@cubby/schemas/nutrition";
import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";
import type {
  RecipeGraphOut,
  RecipeOut,
  SectionIngredientOut,
} from "@cubby/schemas/recipe";
import type { RowDiagnosticOut } from "@cubby/schemas/recipe-shared";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  getNutrientUnitString,
  type NutrientsPer100,
  TIER1_NUTRIENT_KEYS,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";
import { err, ok } from "neverthrow";

import { productNutritionSource } from "~/lib/label-nutrition";
import {
  fromNamedEstimates,
  fromWMeasureEstimate,
} from "~/lib/nutrition-estimates";
import { productWasmInputs } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";

// The costing engine (two-pass totals, consumption model, sub-recipe yield
// scaling, baker %, diagnostics) lives in Rust — recipebridge's costing module
// — behind the single `cost_recipes` export. This module assembles the input
// closure, makes one WASM call per batch, and reshapes the result into the
// shapes the app already consumes. The exported conversion helpers below
// (safeConvertAmount, convertAmountToPrice) are unrelated single-amount
// utilities that keep their non-costing callers.

/** The role a row plays, as classified by ingredient-parser. */
export type IngredientUsage = WIngredientUsage;

/**
 * A section ingredient carrying its enclosing section's name — the costing
 * input shape. The section name matters because some usage classifications are
 * section-level ("For the marinade", "Brine"), not line-level. Build rows with
 * `flattenSections` so every costing entry point agrees.
 */
export type CostingRow = SectionIngredientOut & { sectionName: string | null };
export type RecipeCostingInput = Pick<
  RecipeOut | RecipeGraphOut,
  "id" | "yield" | "sections"
>;

/** Flatten a recipe's sections into costing rows, attaching each section name. */
export const flattenSections = (
  sections: readonly {
    name: string | null;
    ingredients: SectionIngredientOut[];
  }[],
): CostingRow[] =>
  sections.flatMap((s) =>
    s.ingredients.map((i) => ({ ...i, sectionName: s.name })),
  );

/**
 * Generic function to safely convert amounts using wasm
 */
export const safeConvertAmount = (
  amount: Amount,
  mappings: UnitMapping[],
  kind: AmountKind,
): Result<WAmount> => {
  try {
    const result = wasm.conv_amount_to_kind(mappings, kind, amount);
    return ok(result);
  } catch (e) {
    return err(`Error converting to ${kind}: ${e}`);
  }
};

/**
 * Converts an amount to a price measure
 */
export const convertAmountToPrice = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<WAmount> => {
  return safeConvertAmount(amount, mappings, "money");
};

/**
 * Batch sibling of {@link convertAmountToPrice}: N amounts against ONE
 * conversion graph, built once inside WASM instead of per amount.
 *
 * Per-amount failures come back in-band as `WMeasureResult` errors so a single
 * unconvertible row can't blank out the rest of the batch; the outer `Result`
 * is only for whole-call failure, which the Rust `Result<_, String>` surfaces
 * as a *throw* on the JS side (same convention `safeConvertAmount` wraps).
 *
 * Amounts go through {@link toWAmount} rather than straight across: the direct
 * path silently drops `upperValue`.
 */
export const convertAmountsToPrice = (
  amounts: readonly Amount[],
  mappings: readonly UnitMapping[],
): Result<WMeasureResult[]> => {
  try {
    return ok(
      wasm.conv_amounts_to_kind([...mappings], "money", amounts.map(toWAmount)),
    );
  } catch (e) {
    return err(`Error converting to money: ${e}`);
  }
};

/**
 * Evaluate ingredient availability for a batch of groups in ONE WASM call. The
 * gram-first reconciliation + status verdict live in Rust (recipebridge's
 * availability module), shared with the costing engine's conversion kernel; the
 * AvailabilityService owns the DB loads and reshapes the result into the zod
 * `IngredientAvailability` / `AggregatedNeed` output types.
 */
export const evaluateAvailability = (
  input: WAvailabilityInput,
): WAvailabilityResult => wasm.evaluate_availability(input);

/**
 * Flatten planned recipe lines into scaled per-ingredient needs, recursing
 * through sub-recipes by yield. Returns the needs plus every sub-recipe that
 * could NOT be expanded, which the caller is obliged to disclose.
 *
 * Deliberately NOT in `CACHEABLE_METHODS`: the input carries whole recipe
 * closures, so the cache key would be a multi-KB stringify of freshly-built
 * objects that never repeat — the same reason `cost_recipes` is uncached.
 */
export const expandRecipeNeeds = (input: WNeedsInput): WNeedsResult =>
  wasm.expand_recipe_needs(input);

/** Price, weight, and nutrient results for one ingredient (or sub-recipe). */
type IngredientPriceInfo = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
};

export type IngredientDataItem = CostingRow & {
  priceInfo: IngredientPriceInfo | undefined;
  /** Strict row-level totals coverage; can be missing even with numeric partials. */
  totalsMissing: {
    price: boolean;
    weight: boolean;
    nutrients: boolean;
  };
  /** Canonical estimate for every tier-1 nutrient on this row. */
  nutrition: NutritionEstimate;
};

/**
 * The diagnostic shapes are declared once as the zod wire contract in
 * `@cubby/schemas/recipe-shared` and inferred here, so the contract and the source
 * can't silently diverge (the structural compat between the WASM types the
 * reshaper feeds in — PlanTrio, WConversionStep, WIngredientUsage — and these
 * is compiler-enforced at `toRowDiagnostic`).
 */

/**
 * Per-row costing trace: which usage the classifier assigned, which consumption
 * rule fired per measure (the ComponentSource), the basis it drew from, and how
 * each measure resolved — including the exact error string when it didn't.
 * This is the data the per-cell "—" swallows; the debug card and the
 * explain endpoint/MCP tool surface it. JSON-serializable by construction.
 */
type RowDiagnostic = RowDiagnosticOut;

export type CalculateTotalsResult = {
  price: number;
  /** Upper bound of the totals when the recipe has ranged amounts; else absent. */
  priceUpper?: number;
  nutrients: NutrientsPer100;
  /** Parallel upper-bound record, only the ranged nutrient codes present. */
  nutrientsUpper?: NutrientsPer100;
  /**
   * Count of fully covered recipe rows for every requested nutrient code.
   * The WASM projection always supplies this; optional keeps older focused
   * callers and historical test fixtures source-compatible.
   */
  nutrientCoverage?: Record<string, number>;
  weight: number;
  weightUpper?: number;
  totalIngredients: number;
  missingByType: {
    price: string[];
    weight: string[];
    nutrients: string[];
  };
  /** Per-row trace, in input order. Cheap: records what was already computed. */
  diagnostics: RowDiagnostic[];
  /** Canonical completeness-aware totals for durable nutrition consumers. */
  estimates: NutritionTotals;
};

/** One recipe's complete costing: totals plus everything the per-row views need. */
export type RecipeCosting = {
  totals: CalculateTotalsResult;
  /** Rows with their resolved (consumption-model-applied) measures attached. */
  rows: IngredientDataItem[];
  /** Row id → usage, for rows whose measures were adjusted ("est." markers). */
  estimatedRows: Map<string, IngredientUsage>;
  /** Row id → baker's percentage (own grams ÷ flour grams), null when n/a. */
  bakerPct: Map<string, number | null>;
  /** Row id → whether the engine classified it as a flour (baker's-% base). */
  isFlourRows: Map<string, boolean>;
};

/**
 * All tier-1 targets including kcal, in TIER1_NUTRIENTS order. TS stays the
 * source of truth for the list (usda-api shares the package and must not need
 * WASM); the engine special-cases `unit === "kcal"` to the Calories kind.
 */
export const nutrientTargets = (): WCostingInput["nutrient_targets"] =>
  TIER1_NUTRIENT_KEYS.map((key) => ({
    code: TIER1_NUTRIENTS[key].code,
    unit: getNutrientUnitString(key),
  }));

/**
 * The persisted `Amount` (camelCase `upperValue`) → the engine's `WAmount`
 * (snake `upper_value`). Mapping here is what lets a ranged amount ("2–3 cups")
 * actually reach the engine — a straight passthrough would drop the bound.
 */
export const toWAmount = (a: Amount): WAmount => {
  const amount: WAmount = { value: a.value, unit: a.unit };
  if (a.upperValue != null) amount.upper_value = a.upperValue;
  return amount;
};

/** The inverse of {@link toWAmount}, for amounts the engine hands back. */
export const fromWAmount = (a: WAmount): Amount => {
  const amount: Amount = { value: a.value, unit: a.unit };
  if (a.upper_value != null) amount.upperValue = a.upper_value;
  return amount;
};

const toWRow = (
  row: CostingRow,
  getIngredientName: (i: SectionIngredientOut) => string,
): WCostingRow => ({
  id: row.id,
  kind: row.type,
  target_id: row.type === "ingredient" ? row.ingredient.id : row.recipe.id,
  name: getIngredientName(row),
  amounts: row.amounts.map(toWAmount),
  modifier: row.modifier ?? null,
  raw_line: row.rawLine ?? null,
  section_name: row.sectionName,
});

export const toWProductInput = (
  p: ProductWithMappingsAndFoodOut,
): WProductInput => ({
  id: p.id,
  price: p.pricing.effectivePrice,
  ...productWasmInputs(p),
});

const KCAL_CODE = TIER1_NUTRIENTS.kcal.code;

const measureToResult = (m: WMeasureResult): Result<WAmount> =>
  m.ok
    ? ok({ value: m.value, unit: m.unit, upper_value: m.upper_value })
    : err(m.error);

const nutrientsToResult = (n: WNutrientsResult): Result<NutrientsPer100> => {
  if (!n.ok) return err(n.error);
  const record: NutrientsPer100 = {};
  for (const e of n.entries) record[e.code] = e.value;
  return ok(record);
};

/**
 * Reshape an engine row to the zod `rowDiagnostic` wire shape. serde-wasm-
 * bindgen emits `undefined` for Rust `None`, so the nullable contract fields
 * are normalized to explicit null here.
 */
/**
 * Union a row's nutrition source across its ingredient's linked products.
 * Null for sub-recipe rows (no products of their own) or an ingredient the
 * costing input's `ingMap` doesn't carry (shouldn't happen — every row's
 * ingredient is in the closure that built `ingMap` — but a stale-data edge
 * case reports "no known nutrition" rather than a source it can't back up).
 */
const rowNutritionSource = (
  row: CostingRow | undefined,
  ingMap: Record<string, IngredientWithFoodLeanOut>,
): RowDiagnostic["nutritionSource"] => {
  if (!row || row.type !== "ingredient") return null;
  const ing = ingMap[row.ingredient.id];
  if (!ing) return "none";
  const sources = ing.product.map((p) => productNutritionSource(p));
  const hasLabel = sources.includes("label");
  const hasUsda = sources.includes("usda");
  if (hasLabel && hasUsda) return "mixed";
  if (hasLabel) return "label";
  if (hasUsda) return "usda";
  return "none";
};

const toRowDiagnostic = (
  r: WRowResult,
  row: CostingRow | undefined,
  ingMap: Record<string, IngredientWithFoodLeanOut>,
): RowDiagnostic => {
  const diagnostic: RowDiagnostic = {
    id: r.id,
    name: r.name,
    sectionName: r.sectionName ?? null,
    kind: r.kind,
    usage: r.usage,
    measured: r.measured,
    plan: r.plan,
    basisGrams: r.basisGrams ?? null,
    price: r.price.ok
      ? { ok: true, value: r.price.value, unit: r.price.unit }
      : { ok: false, error: r.price.error },
    gram: r.gram.ok
      ? { ok: true, value: r.gram.value, unit: r.gram.unit }
      : { ok: false, error: r.gram.error },
    nutrient: r.nutrients.ok
      ? {
          ok: true,
          kcal:
            r.nutrients.entries.find((e) => e.code === KCAL_CODE)?.value ??
            null,
          nutrientCount: r.nutrients.entries.length,
        }
      : { ok: false, error: r.nutrients.error },
    nutritionSource: rowNutritionSource(row, ingMap),
    missing: r.missing,
  };
  if (r.paths) {
    diagnostic.paths = {
      money: r.paths.money ?? null,
      weight: r.paths.weight ?? null,
      calories: r.paths.calories ?? null,
    };
  }
  return diagnostic;
};

const projectRecipeCosting = (
  w: WRecipeCosting,
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodLeanOut>,
): RecipeCosting => {
  const nutrients: NutrientsPer100 = {};
  const nutrientsUpper: NutrientsPer100 = {};
  const nutrientCoverage: Record<string, number> = {};
  let anyNutrientUpper = false;
  for (const n of w.nutrients) {
    nutrients[n.code] = n.value;
    if (n.upper_value != null) {
      nutrientsUpper[n.code] = n.upper_value;
      anyNutrientUpper = true;
    }
  }
  for (const coverage of w.nutrient_coverage) {
    nutrientCoverage[coverage.code] = coverage.covered;
  }

  const totals: CalculateTotalsResult = {
    price: w.price,
    nutrients,
    nutrientCoverage,
    weight: w.weight,
    totalIngredients: w.total_ingredients,
    missingByType: {
      price: [...w.missing_by_type.price],
      weight: [...w.missing_by_type.weight],
      nutrients: [...w.missing_by_type.nutrients],
    },
    diagnostics: w.rows.map((r, i) => toRowDiagnostic(r, rows[i], ingMap)),
    estimates: {
      cost: fromWMeasureEstimate(w.estimates.cost),
      nutrition: fromNamedEstimates(w.estimates.nutrition),
    },
  };
  if (w.price_upper != null) totals.priceUpper = w.price_upper;
  if (anyNutrientUpper) totals.nutrientsUpper = nutrientsUpper;
  if (w.weight_upper != null) totals.weightUpper = w.weight_upper;

  return {
    totals,
    rows: rows.map((row, i) => {
      const r = w.rows[i];
      return {
        ...row,
        priceInfo: r && {
          price: measureToResult(r.price),
          gram: measureToResult(r.gram),
          nutrient: nutrientsToResult(r.nutrients),
        },
        totalsMissing: r?.missing ?? {
          price: true,
          weight: true,
          nutrients: true,
        },
        nutrition: r ? fromNamedEstimates(r.nutrition) : fromNamedEstimates([]),
      };
    }),
    estimatedRows: new Map(
      w.rows.filter((r) => r.estimated).map((r) => [r.id, r.usage] as const),
    ),
    bakerPct: new Map(
      w.baker_percentages.map((b) => [b.row_id, b.pct ?? null] as const),
    ),
    isFlourRows: new Map(w.rows.map((r) => [r.id, r.is_flour] as const)),
  };
};

/**
 * Cost a batch of recipes in ONE WASM call: totals, per-row resolved measures
 * (consumption model applied — the same trio the totals folded), "est." row
 * markers, baker's percentages, and per-row diagnostics. With `opts.explain`,
 * diagnostics include unit-graph conversion paths (the explain endpoint /
 * debug card / MCP tool payload).
 *
 * `recipeMap` is the sub-recipe closure (recipe-as-ingredient targets,
 * transitively); recipes the engine can't find there are flagged missing,
 * mirroring the old behavior.
 */
export const computeRecipeCosting = (
  recipes: RecipeCostingInput[],
  ingMap: Record<string, IngredientWithFoodLeanOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
  recipeMap: Record<string, RecipeCostingInput> = {},
  opts: { explain?: boolean } = {},
): Map<string, RecipeCosting> => {
  // The closure: roots + every fetched sub-recipe, each serialized once.
  const closure = new Map<string, RecipeCostingInput>();
  for (const r of Object.values(recipeMap)) closure.set(r.id, r);
  for (const r of recipes) closure.set(r.id, r);

  const input: WCostingInput = {
    root_ids: recipes.map((r) => r.id),
    recipes: [...closure.values()].map((r) => ({
      id: r.id,
      recipe_yield: r.yield,
      rows: flattenSections(r.sections).map((row) =>
        toWRow(row, getIngredientName),
      ),
    })),
    ingredients: Object.entries(ingMap).map(([id, ing]) => ({
      id,
      products: ing.product.map(toWProductInput),
    })),
    nutrient_targets: nutrientTargets(),
    explain: opts.explain ?? false,
  };

  const result = wasm.cost_recipes(input);

  const out = new Map<string, RecipeCosting>();
  result.recipes.forEach((w, i) => {
    const recipe = recipes[i];
    if (recipe)
      out.set(
        recipe.id,
        projectRecipeCosting(w, flattenSections(recipe.sections), ingMap),
      );
  });
  return out;
};

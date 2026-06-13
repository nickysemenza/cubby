import type {
  AmountKind,
  WAmount,
  WCostingInput,
  WCostingRow,
  WIngredientUsage,
  WMeasureResult,
  WNutrientsResult,
  WProductInput,
  WRecipeCosting,
  WRowResult,
} from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type {
  MeasureDiagnosticOut,
  NutrientDiagnosticOut,
  RecipeOut,
  RowDiagnosticOut,
  SectionIngredientOut,
} from "@cubby/schemas/recipe";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import {
  getNutrientUnitString,
  type NutrientKey,
  type NutrientsPer100,
  TIER1_NUTRIENTS,
} from "@cubby/usda-schemas";
import { err, ok } from "neverthrow";
import { toWFoodInput } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";
import type {
  IngredientWithFoodOut,
  ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";

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

/** Price, weight, and nutrient results for one ingredient (or sub-recipe). */
export type IngredientPriceInfo = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
};

export type IngredientDataItem = CostingRow & {
  priceInfo: IngredientPriceInfo | undefined;
};

/**
 * The diagnostic shapes are declared once as the zod wire contract in
 * `@cubby/schemas/recipe` and inferred here, so the contract and the source
 * can't silently diverge (the structural compat between the WASM types the
 * reshaper feeds in — PlanTrio, WConversionStep, WIngredientUsage — and these
 * is compiler-enforced at `toRowDiagnostic`).
 */

/** One resolved measure, flattened for display/serialization (no Result). */
export type MeasureDiagnostic = MeasureDiagnosticOut;

/** Nutrient summary diagnostic: kcal + how many nutrient codes resolved. */
export type NutrientDiagnostic = NutrientDiagnosticOut;

/**
 * Per-row costing trace: which usage the classifier assigned, which consumption
 * rule fired per measure (the ComponentSource), the basis it drew from, and how
 * each measure resolved — including the exact error string when it didn't.
 * This is the data the per-cell "—" swallows; the debug card and the
 * explain endpoint/MCP tool surface it. JSON-serializable by construction.
 */
export type RowDiagnostic = RowDiagnosticOut;

export type CalculateTotalsResult = {
  price: number;
  nutrients: NutrientsPer100;
  weight: number;
  totalIngredients: number;
  missingByType: {
    price: string[];
    weight: string[];
    nutrients: string[];
  };
  /** Per-row trace, in input order. Cheap: records what was already computed. */
  diagnostics: RowDiagnostic[];
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

// ---------------------------------------------------------------------------
// Input assembly
// ---------------------------------------------------------------------------

/**
 * All tier-1 targets including kcal, in TIER1_NUTRIENTS order. TS stays the
 * source of truth for the list (usda-api shares the package and must not need
 * WASM); the engine special-cases `unit === "kcal"` to the Calories kind.
 */
const nutrientTargets = (): WCostingInput["nutrient_targets"] =>
  (Object.keys(TIER1_NUTRIENTS) as NutrientKey[]).map((key) => ({
    code: TIER1_NUTRIENTS[key].code,
    unit: getNutrientUnitString(key),
  }));

const toWRow = (
  row: CostingRow,
  getIngredientName: (i: SectionIngredientOut) => string,
): WCostingRow => ({
  id: row.id,
  kind: row.type,
  target_id: row.type === "ingredient" ? row.ingredient.id : row.recipe.id,
  name: getIngredientName(row),
  amounts: row.amounts,
  modifier: row.modifier ?? null,
  raw_line: row.rawLine ?? null,
  section_name: row.sectionName,
});

const toWProductInput = (p: ProductWithMappingsAndFoodOut): WProductInput => ({
  id: p.id,
  price: p.price,
  unit_mappings: p.unitMappings,
  food: p.food ? toWFoodInput(p.food) : null,
});

// ---------------------------------------------------------------------------
// Result reshaping
// ---------------------------------------------------------------------------

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
const toRowDiagnostic = (r: WRowResult): RowDiagnostic => ({
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
          r.nutrients.entries.find((e) => e.code === KCAL_CODE)?.value ?? null,
        nutrientCount: r.nutrients.entries.length,
      }
    : { ok: false, error: r.nutrients.error },
  ...(r.paths
    ? {
        paths: {
          money: r.paths.money ?? null,
          weight: r.paths.weight ?? null,
          calories: r.paths.calories ?? null,
        },
      }
    : {}),
});

const reshape = (w: WRecipeCosting, rows: CostingRow[]): RecipeCosting => {
  const nutrients: NutrientsPer100 = {};
  for (const n of w.nutrients) nutrients[n.code] = n.value;

  return {
    totals: {
      price: w.price,
      nutrients,
      weight: w.weight,
      totalIngredients: w.total_ingredients,
      missingByType: {
        price: [...w.missing_by_type.price],
        weight: [...w.missing_by_type.weight],
        nutrients: [...w.missing_by_type.nutrients],
      },
      diagnostics: w.rows.map(toRowDiagnostic),
    },
    rows: rows.map((row, i) => {
      const r = w.rows[i];
      return {
        ...row,
        priceInfo: r && {
          price: measureToResult(r.price),
          gram: measureToResult(r.gram),
          nutrient: nutrientsToResult(r.nutrients),
        },
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

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
  recipes: RecipeOut[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
  recipeMap: Record<string, RecipeOut> = {},
  opts: { explain?: boolean } = {},
): Map<string, RecipeCosting> => {
  // The closure: roots + every fetched sub-recipe, each serialized once.
  const closure = new Map<string, RecipeOut>();
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
      out.set(recipe.id, reshape(w, flattenSections(recipe.sections)));
  });
  return out;
};

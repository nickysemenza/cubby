import type {
  AmountKind,
  WAmount,
  WIngredientUsage,
} from "@cubby/recipebridge";
import type { Amount } from "@cubby/schemas/codec";
import type {
  RecipeOut,
  RecipeYield,
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
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";
import type {
  IngredientWithFoodOut,
  ProductWithMappingsAndFoodOut,
} from "~/server/services/ingredient.service";

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
 * Get nutrient target unit strings for WASM batch conversion
 * Format: "g protein", "mg sodium", etc.
 * NOTE: kcal is excluded - it must use conv_amount_to_kind("calories") instead
 * because WASM treats Unit::KCal differently from Unit::Other("kcal")
 */
const getNutrientTargets = (): { key: NutrientKey; target: string }[] => {
  return (Object.keys(TIER1_NUTRIENTS) as NutrientKey[])
    .filter((key) => key !== "kcal") // kcal handled separately via conv_amount_to_kind
    .map((key) => ({
      key,
      target: getNutrientUnitString(key),
    }));
};

/**
 * Convert an amount directly to all nutrients via WASM graph traversal
 * This replaces the old TypeScript-based scaling approach
 *
 */
export const convertAmountToNutrients = (
  amount: Amount,
  mappings: UnitMapping[],
): Result<NutrientsPer100> => {
  try {
    const targets = getNutrientTargets();

    // Batch convert to all nutrient targets in a single WASM call (one entry per
    // target, in request order).
    const results = wasm.conv_amount_to_nutrients(
      mappings,
      targets.map((t) => t.target),
      amount,
    );

    // Map each converted target back to its nutrient code.
    const targetToKey = new Map(targets.map((t) => [t.target, t.key] as const));
    const nutrients: NutrientsPer100 = {};
    for (const { target, amount: converted } of results) {
      const key = targetToKey.get(target);
      if (converted && key) {
        nutrients[TIER1_NUTRIENTS[key].code] = converted.value;
      }
    }

    // Handle kcal separately using conv_amount_to_kind("calories")
    // This is needed because WASM treats Unit::KCal differently from Unit::Other("kcal")
    // MeasureKind::Nutrient("kcal") creates Unit::Other("kcal"), but mappings use Unit::KCal
    try {
      const kcalResult = wasm.conv_amount_to_kind(mappings, "calories", amount);
      if (kcalResult) {
        const kcalCode = TIER1_NUTRIENTS.kcal.code;
        nutrients[kcalCode] = kcalResult.value;
      }
    } catch {
      // kcal conversion failed - this is fine, just means no path exists
    }

    // Check if we got any nutrients
    if (Object.keys(nutrients).length === 0) {
      return err("No nutrient conversions succeeded");
    }

    return ok(nutrients);
  } catch (e) {
    return err(`Error converting to nutrients: ${e}`);
  }
};

/**
 * Creates an empty nutrients record
 *
 */
export const createEmptyNutrients = (): NutrientsPer100 =>
  ({}) as NutrientsPer100;

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
 * Extracts gram and nutrient results separately using WASM for both conversions.
 * Weight and nutrient conversions are now independent - both use the graph.
 *
 */
export const getGramAndNutrient = (
  amount: Amount,
  mappings: UnitMapping[],
  _product: ProductWithMappingsAndFoodOut[] | undefined,
): { gram: Result<WAmount>; nutrient: Result<NutrientsPer100> } => {
  // Convert amount to weight via WASM graph
  const gramResult = safeConvertAmount(amount, mappings, "weight");

  // Convert amount to nutrients via WASM graph (independent of weight conversion)
  const nutrientResult = convertAmountToNutrients(amount, mappings);

  return {
    gram: gramResult,
    nutrient: nutrientResult,
  };
};

/**
 * Sums multiple nutrient records, combining all nutrient codes
 */
const sumNutrients = (nutrients: NutrientsPer100[]): NutrientsPer100 => {
  const result: NutrientsPer100 = {};
  for (const n of nutrients) {
    for (const [code, amount] of Object.entries(n)) {
      result[code] = (result[code] ?? 0) + (amount ?? 0);
    }
  }
  return result;
};

/**
 * Builds a manual unit mapping for sub-recipe yield scaling.
 */
const makeYieldMapping = (a: Amount, b: Amount): UnitMapping => ({
  a,
  b,
  source: "sub-recipe",
  sourceMetadata: { type: "manual" },
});

/**
 * Expresses a sub-recipe's computed totals as unit mappings relative to its
 * yield (e.g. "1 batch = $C = W g = N g protein = M kcal"). Feeding the parent's
 * amount through these mappings via the existing WASM conversions yields the
 * yield-scaled cost/weight/nutrient contribution — "2 cups of a recipe yielding
 * 4 cups" contributes half its totals.
 */
const buildYieldMappings = (
  recipeYield: RecipeYield,
  totals: CalculateTotalsResult,
): UnitMapping[] => {
  const yieldAmount: Amount = {
    value: recipeYield.value,
    unit: recipeYield.unit,
  };
  const mappings: UnitMapping[] = [
    makeYieldMapping(yieldAmount, { value: totals.price, unit: "dollar" }),
    makeYieldMapping(yieldAmount, { value: totals.weight, unit: "g" }),
  ];
  // One mapping per nutrient present in the sub-recipe totals. getNutrientUnitString
  // returns "kcal" for the kcal key, matching the calories conversion path.
  for (const key of Object.keys(TIER1_NUTRIENTS) as NutrientKey[]) {
    const value = totals.nutrients[TIER1_NUTRIENTS[key].code];
    if (value == null) continue;
    mappings.push(
      makeYieldMapping(yieldAmount, {
        value,
        unit: getNutrientUnitString(key),
      }),
    );
  }
  return mappings;
};

/**
 * Computes a sub-recipe's totals and returns yield-relative mappings, or null
 * when it can't be costed: the sub-recipe wasn't fetched, has no yield to scale
 * against, or a cycle was detected (A → B → A). `visited` guards the cycle.
 */
const getSubRecipeMappings = (
  subId: string,
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut>,
  visited: Set<string>,
): UnitMapping[] | null => {
  if (visited.has(subId)) return null; // cycle guard
  const sub = recipeMap[subId];
  if (!sub || sub.yield == null) return null;

  const subTotals = calculateTotals(
    flattenSections(sub.sections),
    ingMap,
    (ing) => ing.id, // nested missing-data labels are discarded; identity is fine
    recipeMap,
    new Set([...visited, subId]),
  );
  return buildYieldMappings(sub.yield, subTotals);
};

/** Price, weight, and nutrient results for one ingredient (or sub-recipe). */
export type IngredientPriceInfo = {
  price: Result<WAmount>;
  gram: Result<WAmount>;
  nutrient: Result<NutrientsPer100>;
};

/**
 * Converts one amount to price, weight, and all nutrients in a single WASM call
 * (`conv_amount_all` builds the unit-mapping graph once and returns every
 * measure), then reshapes into the `{ price, gram, nutrient }` Result trio. This
 * replaces the per-ingredient fan-out of convertAmountToPrice + getGramAndNutrient
 * (4 boundary crossings) on the costing hot path; the granular helpers stay for
 * their other callers.
 */
const measuresFromMappings = (
  amount: Amount,
  mappings: UnitMapping[],
): IngredientPriceInfo => {
  try {
    const targets = getNutrientTargets();
    const all = wasm.conv_amount_all(
      mappings,
      targets.map((t) => t.target),
      amount,
    );

    // Map each converted nutrient target back to its code; kcal rides in the
    // dedicated `calories` field (same Unit::KCal handling the old code did
    // separately).
    const targetToKey = new Map(targets.map((t) => [t.target, t.key] as const));
    const nutrients: NutrientsPer100 = {};
    for (const { target, amount: converted } of all.nutrients) {
      const key = targetToKey.get(target);
      if (converted && key) {
        nutrients[TIER1_NUTRIENTS[key].code] = converted.value;
      }
    }
    if (all.calories) {
      nutrients[TIER1_NUTRIENTS.kcal.code] = all.calories.value;
    }

    return {
      price: all.money ? ok(all.money) : err("Error converting to money"),
      gram: all.weight ? ok(all.weight) : err("Error converting to weight"),
      nutrient:
        Object.keys(nutrients).length === 0
          ? err("No nutrient conversions succeeded")
          : ok(nutrients),
    };
  } catch (e) {
    const error = `Error converting amount: ${e}`;
    return { price: err(error), gram: err(error), nutrient: err(error) };
  }
};

/**
 * Gets price, weight, and nutrient information for an ingredient.
 *
 * For recipe-as-ingredient (sub-recipe) entries, rolls up the sub-recipe's own
 * totals — scaled by amount/yield — instead of treating it as missing data.
 */
const getIngredientMeasures = (
  ingredient: SectionIngredientOut,
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut> = {},
  visited: Set<string> = new Set(),
): IngredientPriceInfo => {
  const firstAmount = ingredient.amounts[0];

  if (!firstAmount) {
    const error = `ingredient ${ingredient.id} has no amounts`;
    return {
      price: err(error),
      gram: err(error),
      nutrient: err(error),
    };
  }

  // Sub-recipe: build mappings from the sub-recipe's rolled-up totals, then
  // scale by the amount used via the same conversion as a normal ingredient.
  if (ingredient.type === "recipe") {
    const mappings = getSubRecipeMappings(
      ingredient.recipe.id,
      ingMap,
      recipeMap,
      visited,
    );
    if (!mappings) {
      const error = `sub-recipe ${ingredient.recipe.id} could not be costed`;
      return { price: err(error), gram: err(error), nutrient: err(error) };
    }
    return measuresFromMappings(firstAmount, mappings);
  }

  const entry = ingMap[ingredient.ingredient.id];
  const product = entry?.product;
  const mappings = (product ?? []).flatMap((p) =>
    getAllUnitMappingsFromProduct(p),
  );

  return measuresFromMappings(firstAmount, mappings);
};

// ---------------------------------------------------------------------------
// Consumption model: the recipe line is not always what you eat.
//
// Each row's usage role (classified by the wasm parser from modifier/rawLine/
// section name) maps to a per-measure plan: cost, weight, and nutrients each
// resolve from one source. This is the single table both `calculateTotals` and
// the per-row views consume — the constants below are the tuning knobs.
// ---------------------------------------------------------------------------

/** The role a row plays, as classified by ingredient-parser. */
export type IngredientUsage = WIngredientUsage;

/**
 * Fraction of a fried dish's (raw) batter weight that ends up absorbed as oil and
 * actually eaten. Deep-fried dough takes on roughly 10–20% of its weight in oil;
 * 0.15 is a middle-ground guesstimate. NOTE: it's applied to *raw* batter weight
 * (before frying drives off water), so it deliberately folds the evaporation
 * effect into the constant — this is the single knob to turn for accuracy.
 */
export const FRY_OIL_ABSORPTION_FRACTION = 0.15;
/** "Salt to taste" ≈ 1% of dish weight — a standard seasoning rate. */
const SEASONING_BASIS_FRACTION = 0.01;
/** Unmeasured "butter, for the pan": a flat ~10 g, nearly all of it eaten. */
const PAN_GREASE_GRAMS = 10;
/** Unmeasured "parsley, for garnish": a flat ~5 g flourish. */
const GARNISH_GRAMS = 5;
/** Unmeasured "flour, for dusting": adhered coating ≈ 5% of dish weight. */
const DREDGE_BASIS_FRACTION = 0.05;
/** Measured dredging flour: only ~20% of the bowl ends up on the food. */
const DREDGE_RETAINED_FRACTION = 0.2;
/** Measured marinade: ~15% clings to the food; the rest is discarded. */
const MARINADE_RETAINED_FRACTION = 0.15;

/** Where one measure (cost, weight, or nutrients) of a row resolves from. */
type ComponentSource =
  | { kind: "own-full" } // the row's own amount, as written
  | { kind: "own-fraction"; fraction: number } // fraction of the own amount
  | { kind: "basis-fraction"; fraction: number } // fraction of the other rows' weight
  | { kind: "flat-grams"; grams: number } // a fixed gram estimate
  | { kind: "missing" }; // no basis at all (errors into missingByType)

/** How a row's three measures resolve. */
type ConsumptionPlan = {
  usage: IngredientUsage;
  cost: ComponentSource;
  weight: ComponentSource;
  nutrients: ComponentSource;
};

type PlanTrio = Pick<ConsumptionPlan, "cost" | "weight" | "nutrients">;

const ownFull: ComponentSource = { kind: "own-full" };
const missing: ComponentSource = { kind: "missing" };
const ownFraction = (fraction: number): ComponentSource => ({
  kind: "own-fraction",
  fraction,
});
const basisFraction = (fraction: number): ComponentSource => ({
  kind: "basis-fraction",
  fraction,
});
const flatGrams = (grams: number): ComponentSource => ({
  kind: "flat-grams",
  grams,
});
const all = (source: ComponentSource): PlanTrio => ({
  cost: source,
  weight: source,
  nutrients: source,
});

/**
 * The consumption table, per usage × measured/unmeasured. Notable asymmetries:
 * - Measured frying oil ("2 quarts oil, for frying"): the amount is the POT
 *   volume, not consumption — full cost (you bought it), absorbed weight and
 *   nutrients (you ate ~15% of batter weight, not 7,700 kcal of oil).
 * - Measured marinade/dredging: full cost, fractional weight/nutrition (the
 *   rest is discarded).
 */
const USAGE_CONSUMPTION: Record<
  IngredientUsage,
  { measured: PlanTrio; unmeasured: PlanTrio }
> = {
  normal: { measured: all(ownFull), unmeasured: all(missing) },
  frying_medium: {
    measured: {
      cost: ownFull,
      weight: basisFraction(FRY_OIL_ABSORPTION_FRACTION),
      nutrients: basisFraction(FRY_OIL_ABSORPTION_FRACTION),
    },
    unmeasured: all(basisFraction(FRY_OIL_ABSORPTION_FRACTION)),
  },
  seasoning: {
    measured: all(ownFull),
    unmeasured: all(basisFraction(SEASONING_BASIS_FRACTION)),
  },
  pan_grease: {
    measured: all(ownFull),
    unmeasured: all(flatGrams(PAN_GREASE_GRAMS)),
  },
  garnish: {
    measured: all(ownFull),
    unmeasured: all(flatGrams(GARNISH_GRAMS)),
  },
  dredging: {
    measured: {
      cost: ownFull,
      weight: ownFraction(DREDGE_RETAINED_FRACTION),
      nutrients: ownFraction(DREDGE_RETAINED_FRACTION),
    },
    unmeasured: all(basisFraction(DREDGE_BASIS_FRACTION)),
  },
  marinade: {
    measured: {
      cost: ownFull,
      weight: ownFraction(MARINADE_RETAINED_FRACTION),
      nutrients: ownFraction(MARINADE_RETAINED_FRACTION),
    },
    // An unmeasured marinade line has no estimable basis — leave it missing.
    unmeasured: all(missing),
  },
};

/**
 * Build a row's consumption plan. Sub-recipe rows are always normal (their
 * internals already applied their own model); ingredient rows are classified
 * by the wasm parser (LRU-cached — pure string work, repeated args).
 */
const planConsumption = (row: CostingRow, name: string): ConsumptionPlan => {
  const usage: IngredientUsage =
    row.type === "recipe"
      ? "normal"
      : wasm.classify_ingredient_usage(
          name,
          row.modifier ?? undefined,
          row.rawLine ?? undefined,
          row.sectionName ?? undefined,
        );
  const trio =
    USAGE_CONSUMPTION[usage][row.amounts[0] ? "measured" : "unmeasured"];
  return { usage, ...trio };
};

/**
 * True when any measure depends on the basis weight (or is a flat estimate) —
 * these rows resolve in pass 2, after the basis is known, and their own
 * amounts never enter the basis.
 */
const isDeferred = (plan: ConsumptionPlan): boolean =>
  [plan.cost, plan.weight, plan.nutrients].some(
    (c) => c.kind === "basis-fraction" || c.kind === "flat-grams",
  );

/** True when any measure is adjusted away from the written amount ("est."). */
const isEstimatedPlan = (plan: ConsumptionPlan): boolean =>
  [plan.cost, plan.weight, plan.nutrients].some(
    (c) => c.kind !== "own-full" && c.kind !== "missing",
  );

/** Whether a row's own weight contributes to the basis other rows estimate
 * from. Own-full only, deliberately: a measured marinade's *retained* grams
 * are themselves an estimate, so they don't feed a sibling fry-oil's basis. */
const contributesToBasis = (plan: ConsumptionPlan): boolean =>
  plan.weight.kind === "own-full";

/**
 * Measures for an estimated gram weight, converted through the ingredient's own
 * USDA/price unit mappings — calories, sodium, and (tiny) cost all come from
 * the linked food with no hardcoded per-food constants. Error Results when
 * there's no estimable basis or no resolvable mappings (renders as "—").
 */
const estimatedMeasures = (
  grams: number,
  row: CostingRow,
  ingMap: Record<string, IngredientWithFoodOut>,
): IngredientPriceInfo => {
  if (row.type !== "ingredient" || grams <= 0) {
    const error = "no basis for estimate";
    return { price: err(error), gram: err(error), nutrient: err(error) };
  }
  const entry = ingMap[row.ingredient.id];
  const mappings = (entry?.product ?? []).flatMap((p) =>
    getAllUnitMappingsFromProduct(p),
  );
  return measuresFromMappings({ value: grams, unit: "g" }, mappings);
};

const scaleAmount = (
  result: Result<WAmount>,
  fraction: number,
): Result<WAmount> =>
  result.map((a) => ({
    ...a,
    value: a.value * fraction,
    upper_value:
      a.upper_value != null ? a.upper_value * fraction : a.upper_value,
  }));

const scaleNutrients = (
  result: Result<NutrientsPer100>,
  fraction: number,
): Result<NutrientsPer100> =>
  result.map((nutrients) =>
    Object.fromEntries(
      Object.entries(nutrients).map(([code, value]) => [
        code,
        (value ?? 0) * fraction,
      ]),
    ),
  );

/**
 * Resolve a row's three measures per its plan. At most two conversions run:
 * the row's own trio (lazy — only when some measure is own-*) and one
 * estimated-grams trio. `precomputedOwn` lets per-row views reuse the trio
 * `createIngredientData` already computed.
 */
const resolveRowMeasures = (
  row: CostingRow,
  plan: ConsumptionPlan,
  basisGrams: number,
  ingMap: Record<string, IngredientWithFoodOut>,
  recipeMap: Record<string, RecipeOut>,
  visited: Set<string>,
  precomputedOwn?: IngredientPriceInfo,
): IngredientPriceInfo => {
  let ownTrio = precomputedOwn;
  const own = (): IngredientPriceInfo =>
    (ownTrio ??= getIngredientMeasures(row, ingMap, recipeMap, visited));

  // One estimate trio per distinct gram value (in practice: one).
  const estCache = new Map<number, IngredientPriceInfo>();
  const est = (grams: number): IngredientPriceInfo => {
    const cached = estCache.get(grams);
    if (cached) return cached;
    const info = estimatedMeasures(grams, row, ingMap);
    estCache.set(grams, info);
    return info;
  };

  const amountFor = (
    source: ComponentSource,
    key: "price" | "gram",
  ): Result<WAmount> => {
    switch (source.kind) {
      case "own-full":
        return own()[key];
      case "own-fraction":
        return scaleAmount(own()[key], source.fraction);
      case "basis-fraction":
        return est(source.fraction * basisGrams)[key];
      case "flat-grams":
        return est(source.grams)[key];
      case "missing":
        return err(`ingredient ${row.id} has no amounts`);
    }
  };

  const nutrientsFor = (source: ComponentSource): Result<NutrientsPer100> => {
    switch (source.kind) {
      case "own-full":
        return own().nutrient;
      case "own-fraction":
        return scaleNutrients(own().nutrient, source.fraction);
      case "basis-fraction":
        return est(source.fraction * basisGrams).nutrient;
      case "flat-grams":
        return est(source.grams).nutrient;
      case "missing":
        return err(`ingredient ${row.id} has no amounts`);
    }
  };

  return {
    price: amountFor(plan.cost, "price"),
    gram: amountFor(plan.weight, "gram"),
    nutrient: nutrientsFor(plan.nutrients),
  };
};

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
};

/**
 * Calculates price, weight, and nutrient information for a list of ingredients,
 * applying each row's consumption plan (see USAGE_CONSUMPTION).
 */
export const calculateTotals = (
  ingredients: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getIngredientName: (ingredient: SectionIngredientOut) => string,
  recipeMap: Record<string, RecipeOut> = {},
  visited: Set<string> = new Set(),
): CalculateTotalsResult => {
  const prices: WAmount[] = [];
  const grams: WAmount[] = [];
  const nutrients: NutrientsPer100[] = [];
  const missingByType = {
    price: [] as string[],
    weight: [] as string[],
    nutrients: [] as string[],
  };

  // Collect the trio into the running totals, routing failures to missingByType.
  const fold = (
    { price, gram, nutrient }: IngredientPriceInfo,
    ingName: string,
  ) => {
    if (price.isOk()) prices.push(price.value);
    else missingByType.price.push(ingName);
    if (gram.isOk()) grams.push(gram.value);
    else missingByType.weight.push(ingName);
    if (nutrient.isOk()) nutrients.push(nutrient.value);
    else missingByType.nutrients.push(ingName);
  };

  const planned = ingredients.map((row) => {
    const name = getIngredientName(row);
    return { row, name, plan: planConsumption(row, name) };
  });

  // Resolve a row and fold it, routing thrown errors to every missing
  // category. Returns the resolved trio (null when it threw).
  const resolveAndFold = (
    { row, name, plan }: (typeof planned)[number],
    basisGrams: number,
  ): IngredientPriceInfo | null => {
    try {
      const info = resolveRowMeasures(
        row,
        plan,
        basisGrams,
        ingMap,
        recipeMap,
        visited,
      );
      fold(info, name);
      return info;
    } catch (e) {
      console.error(`Error calculating measures for ${name}`, e);
      missingByType.price.push(name);
      missingByType.weight.push(name);
      missingByType.nutrients.push(name);
      return null;
    }
  };

  // Pass 1: rows whose measures resolve from their own amounts. Accumulate the
  // basis weight from own-full rows only — a deferred row (incl. a MEASURED
  // frying medium, whose written amount is the pot volume) never feeds the
  // basis, so pass 2 is order-independent.
  let basisGrams = 0;
  const deferred: typeof planned = [];
  for (const p of planned) {
    if (isDeferred(p.plan)) {
      deferred.push(p);
      continue;
    }
    const info = resolveAndFold(p, 0);
    if (contributesToBasis(p.plan) && info?.gram.isOk()) {
      basisGrams += info.gram.value.value;
    }
  }

  // Pass 2: basis-dependent and flat estimates, now that the basis is known.
  for (const p of deferred) {
    resolveAndFold(p, basisGrams);
  }

  // Calculate totals (weight includes the estimated rows — they're eaten)
  const totalPrice = prices.reduce((acc, curr) => acc + (curr.value || 0), 0);
  const totalWeight = grams.reduce((acc, curr) => acc + curr.value, 0);
  const totalNutrients = sumNutrients(nutrients);

  return {
    price: totalPrice,
    nutrients: totalNutrients,
    weight: totalWeight,
    totalIngredients: ingredients.length,
    missingByType,
  };
};

export type IngredientDataItem = CostingRow & {
  priceInfo: IngredientPriceInfo | undefined;
};

/**
 * Baker's percentage per ingredient: its weight in grams as a percentage of the
 * total flour weight (flour = 100%). Returns a Map keyed by ingredient row id.
 * Entries are null when the ingredient has no gram weight, or when no flour was
 * detected / flour weight is zero (no valid base to divide by).
 */
export const computeBakerPercentages = (
  data: IngredientDataItem[],
  getName: (i: SectionIngredientOut) => string,
  isFlour: (name: string) => boolean,
): Map<string, number | null> => {
  let flourGrams = 0;
  for (const row of data) {
    const gram = row.priceInfo?.gram;
    if (gram?.isOk() && isFlour(getName(row))) {
      flourGrams += gram.value.value;
    }
  }

  const result = new Map<string, number | null>();
  for (const row of data) {
    const gram = row.priceInfo?.gram;
    result.set(
      row.id,
      flourGrams > 0 && gram?.isOk()
        ? (gram.value.value / flourGrams) * 100
        : null,
    );
  }
  return result;
};

/**
 * Per-row estimated measures for usage-adjusted rows, keyed by row id (mirrors
 * computeBakerPercentages). The basis is the summed gram weight of own-full
 * rows — the same basis calculateTotals() uses — so the row display and the
 * totals agree. Only rows with an estimated plan appear in the map.
 */
export const computeUsageEstimates = (
  data: IngredientDataItem[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getName: (i: SectionIngredientOut) => string,
): Map<string, { info: IngredientPriceInfo; usage: IngredientUsage }> => {
  const plans = data.map((row) => ({
    row,
    plan: planConsumption(row, getName(row)),
  }));

  let basisGrams = 0;
  for (const { row, plan } of plans) {
    const gram = row.priceInfo?.gram;
    if (contributesToBasis(plan) && gram?.isOk()) {
      basisGrams += gram.value.value;
    }
  }

  const result = new Map<
    string,
    { info: IngredientPriceInfo; usage: IngredientUsage }
  >();
  for (const { row, plan } of plans) {
    if (!isEstimatedPlan(plan)) continue;
    result.set(row.id, {
      // Reuse the own trio createIngredientData already computed (own-fraction
      // plans scale it; estimate plans never touch it).
      info: resolveRowMeasures(
        row,
        plan,
        basisGrams,
        ingMap,
        {},
        new Set(),
        row.priceInfo,
      ),
      usage: plan.usage,
    });
  }
  return result;
};

/**
 * Returns ingredient rows with usage-adjusted rows' priceInfo replaced by the
 * consumption-model estimate, plus a map of those row ids to their usage (for
 * the "est."/"absorbed" markers). Use this anywhere per-ingredient measures
 * feed a view (table, treemap, sunburst) so estimates are included
 * consistently with the recipe totals — `calculateTotals` folds them in too.
 * Note this also overrides MEASURED frying/dredging/marinade rows: their
 * displayed weight/nutrition become the estimate while cost stays as written.
 */
export const applyUsageEstimates = (
  data: IngredientDataItem[],
  ingMap: Record<string, IngredientWithFoodOut>,
  getName: (i: SectionIngredientOut) => string,
): {
  data: IngredientDataItem[];
  estimatedRows: Map<string, IngredientUsage>;
} => {
  const estimates = computeUsageEstimates(data, ingMap, getName);
  if (estimates.size === 0) return { data, estimatedRows: new Map() };
  return {
    data: data.map((row) => {
      const estimate = estimates.get(row.id);
      return estimate ? { ...row, priceInfo: estimate.info } : row;
    }),
    estimatedRows: new Map(
      [...estimates].map(([id, e]) => [id, e.usage] as const),
    ),
  };
};

/**
 * Creates a wrapper for tracking ingredient data with price/nutrient info
 */
export const createIngredientData = (
  ingredients: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut> | undefined,
  recipeMap: Record<string, RecipeOut> = {},
): IngredientDataItem[] => {
  return ingredients.map((i) => ({
    ...i,
    priceInfo: ingMap ? getIngredientMeasures(i, ingMap, recipeMap) : undefined,
  }));
};

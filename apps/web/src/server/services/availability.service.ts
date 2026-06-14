import type {
  AggregatedNeed,
  IngredientAvailability,
  IngredientAvailabilityStatus,
  RecipeAvailability,
} from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import type { IngredientId, RecipeId } from "@cubby/schemas/identifiers";
import type { SectionIngredientOut } from "@cubby/schemas/recipe";
import { uniq } from "es-toolkit";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getInventoryForProducts } from "~/server/repo/inventory";
import { getRecipeByID } from "~/server/repo/recipe";
import type {
  IngredientService,
  IngredientWithFoodOut,
} from "./ingredient.service";

// Output types live in @cubby/schemas/availability (single source of truth, shared
// with the suggestions router's .output()).

/** Tiny tolerance so float rounding doesn't flip an exact match to "short". */
const COVERAGE_EPSILON = 1e-6;

/**
 * Cross-references a recipe's ingredients against current inventory, reconciling
 * units through each linked product's unit mappings (via WASM), to answer
 * "do I have what this recipe needs, and what am I short?".
 *
 * Comparison happens in grams whenever the need converts to a weight (the usual
 * case for food, where a product's mappings bridge volume/count → grams). WASM
 * density bridges only run one way (e.g. cup → g, not g → cup), so a single
 * canonical basis is more reliable than converting each amount to the need's
 * unit. Ingredients with no weight path fall back to an exact-unit comparison.
 *
 * This is the shared engine behind "what can I make?", the find_cookable_recipes
 * agent tool, and the meal-planning shopping list.
 */
export class AvailabilityService {
  constructor(
    private db: Database,
    private ingredientService: IngredientService,
  ) {}

  async getRecipeAvailability(recipeId: RecipeId): Promise<RecipeAvailability> {
    const recipe = await getRecipeByID(this.db, recipeId);
    if (!recipe) {
      throw createAppError("RECIPE_NOT_FOUND", `Recipe ${recipeId} not found`);
    }

    const sectionIngredients = recipe.sections.flatMap((s) => s.ingredients);

    // Load each distinct direct ingredient with its products, food-enriched so
    // USDA-derived mappings (e.g. density) are available for unit conversion.
    const directIds = uniq(
      sectionIngredients
        .filter(
          (si): si is Extract<SectionIngredientOut, { type: "ingredient" }> =>
            si.type === "ingredient",
        )
        .map((si) => si.ingredient.id),
    );
    const ingredientEntries = await Promise.all(
      directIds.map((id) => this.ingredientService.getIngredientByID(id)),
    );
    const ingMap = new Map<IngredientId, IngredientWithFoodOut>(
      ingredientEntries.map((ing) => [ing.id, ing]),
    );

    // One batched inventory read across every product of every ingredient.
    const productIds = uniq(
      ingredientEntries.flatMap((ing) => ing.product.map((p) => p.id)),
    );
    const inventory = await getInventoryForProducts(this.db, productIds);
    const inventoryByProduct = new Map<string, Amount[]>();
    for (const { productId, amount } of inventory) {
      const list = inventoryByProduct.get(productId);
      if (list) list.push(amount);
      else inventoryByProduct.set(productId, [amount]);
    }

    const ingredients = sectionIngredients.map((si) =>
      this.evaluateIngredient(si, ingMap, inventoryByProduct),
    );

    const resolvable = ingredients.filter((i) => i.status !== "subrecipe");
    const available = resolvable.filter((i) => i.status === "ok");

    return {
      recipeId,
      recipeName: recipe.name,
      coverage:
        resolvable.length === 0 ? 1 : available.length / resolvable.length,
      totalIngredients: resolvable.length,
      availableIngredients: available.length,
      ingredients,
      missing: resolvable.filter((i) => i.status !== "ok").map((i) => i.name),
    };
  }

  /**
   * Aggregate ingredient needs across many planned recipes (the meal-planning
   * shopping list). Each line is a recipe to make at a scale; needs are scaled and
   * summed per ingredient, while on-hand inventory is counted ONCE per ingredient
   * (summing per-line availability would multiply inventory by the number of
   * recipes that use it — the load-bearing reason this isn't a sum of
   * getRecipeAvailability calls). Reconciliation is the same gram-first basis.
   *
   * `sources[].lineIndex` indexes back into `lines`, so the caller can attribute
   * each contribution to its meal/recipe. Sub-recipes are not expanded in v1.
   */
  async getAggregatedNeeds(
    lines: { recipeId: RecipeId; scale: number }[],
  ): Promise<AggregatedNeed[]> {
    if (lines.length === 0) return [];

    // Load each distinct recipe once (a recipe may be planned in several meals).
    const distinctRecipeIds = uniq(lines.map((l) => l.recipeId));
    const recipeEntries = await Promise.all(
      distinctRecipeIds.map(
        async (id) => [id, await getRecipeByID(this.db, id)] as const,
      ),
    );
    const recipeMap = new Map(recipeEntries);

    // Flatten to per-ingredient contributions, scaling each need by its line.
    type Contribution = {
      ingredientId: IngredientId;
      name: string;
      scaledNeed: Amount;
      lineIndex: number;
    };
    const contributions: Contribution[] = [];
    lines.forEach((line, lineIndex) => {
      const recipe = recipeMap.get(line.recipeId);
      if (!recipe) return; // deleted/missing recipe — skip
      for (const section of recipe.sections) {
        for (const si of section.ingredients) {
          if (si.type !== "ingredient") continue; // v1: sub-recipes not expanded
          const need = si.amounts[0];
          if (!need) continue;
          contributions.push({
            ingredientId: si.ingredient.id,
            name: si.ingredient.name,
            scaledNeed: {
              value: need.value * line.scale,
              unit: need.unit,
              ...(need.upperValue != null
                ? { upperValue: need.upperValue * line.scale }
                : {}),
            },
            lineIndex,
          });
        }
      }
    });
    if (contributions.length === 0) return [];

    // Load each distinct ingredient (food-enriched, for density mappings) + one
    // batched inventory read across all their products.
    const distinctIngredientIds = uniq(
      contributions.map((c) => c.ingredientId),
    );
    const ingredientEntries = await Promise.all(
      distinctIngredientIds.map((id) =>
        this.ingredientService.getIngredientByID(id),
      ),
    );
    const ingMap = new Map<IngredientId, IngredientWithFoodOut>(
      ingredientEntries.map((ing) => [ing.id, ing]),
    );
    const productIds = uniq(
      ingredientEntries.flatMap((ing) => ing.product.map((p) => p.id)),
    );
    const inventory = await getInventoryForProducts(this.db, productIds);
    const inventoryByProduct = new Map<string, Amount[]>();
    for (const { productId, amount } of inventory) {
      const list = inventoryByProduct.get(productId);
      if (list) list.push(amount);
      else inventoryByProduct.set(productId, [amount]);
    }

    // Group contributions by ingredient and evaluate each once.
    const byIngredient = new Map<IngredientId, Contribution[]>();
    for (const c of contributions) {
      const list = byIngredient.get(c.ingredientId);
      if (list) list.push(c);
      else byIngredient.set(c.ingredientId, [c]);
    }

    return Array.from(byIngredient.entries()).map(([ingredientId, contribs]) =>
      this.evaluateAggregate(
        ingredientId,
        contribs,
        ingMap,
        inventoryByProduct,
      ),
    );
  }

  private evaluateAggregate(
    ingredientId: IngredientId,
    contribs: { scaledNeed: Amount; lineIndex: number; name: string }[],
    ingMap: Map<IngredientId, IngredientWithFoodOut>,
    inventoryByProduct: Map<string, Amount[]>,
  ): AggregatedNeed {
    const name = contribs[0]?.name ?? "";
    const products = (ingMap.get(ingredientId)?.product ?? []).map((p) => ({
      mappings: getAllUnitMappingsFromProduct(p),
      amounts: inventoryByProduct.get(p.id) ?? [],
    }));
    const anyEntries = products.some((p) => p.amounts.length > 0);
    const allMappings = products.flatMap((p) => p.mappings);

    // Prefer a grams basis: only when EVERY contribution converts to weight, so
    // sources are summable in one unit. Otherwise fall back to the (assumed
    // shared) authored unit — same gram-first rule as evaluateIngredient.
    const weights = contribs.map((c) =>
      safeConvertAmount(c.scaledNeed, allMappings, "weight"),
    );
    const allWeight = weights.length > 0 && weights.every((w) => w.isOk());

    let basisUnit: string;
    const sources = contribs.map((c, i) => {
      const w = weights[i];
      const needValue =
        allWeight && w?.isOk() ? w.value.value : c.scaledNeed.value;
      return { lineIndex: c.lineIndex, needValue };
    });
    if (allWeight) {
      const first = weights[0];
      basisUnit = first?.isOk() ? first.value.unit : "g";
    } else {
      // v1 limitation: when not every contribution converts to weight, we sum in
      // the first contribution's unit and assume all recipes use the same unit
      // for this ingredient. Mixed units (e.g. "2 cup" + "300 g") produce a
      // unit-incoherent total — the same gram-first fallback as evaluateIngredient.
      basisUnit = contribs[0]?.scaledNeed.unit ?? "";
    }
    const needTotal = sources.reduce((sum, s) => sum + s.needValue, 0);

    // On-hand total, counted once for the ingredient across all its products.
    let haveTotal = 0;
    let anyConvertible = false;
    for (const product of products) {
      for (const onHand of product.amounts) {
        if (allWeight) {
          const grams = safeConvertAmount(onHand, product.mappings, "weight");
          if (grams.isOk()) {
            haveTotal += grams.value.value;
            anyConvertible = true;
          }
        } else if (onHand.unit === basisUnit) {
          haveTotal += onHand.value;
          anyConvertible = true;
        }
      }
    }

    return {
      ingredientId,
      name,
      basisUnit,
      needValue: needTotal,
      haveValue: anyConvertible ? haveTotal : null,
      status: resolveStatus(needTotal, haveTotal, anyEntries, anyConvertible),
      sources,
    };
  }

  private evaluateIngredient(
    si: SectionIngredientOut,
    ingMap: Map<IngredientId, IngredientWithFoodOut>,
    inventoryByProduct: Map<string, Amount[]>,
  ): IngredientAvailability {
    // Sub-recipes aren't expanded in v1 — flagged and excluded from coverage.
    if (si.type === "recipe") {
      return {
        ingredientId: null,
        name: si.recipe.name,
        need: si.amounts[0] ?? null,
        basisUnit: null,
        needValue: null,
        haveValue: null,
        status: "subrecipe",
      };
    }

    const ingredientId = si.ingredient.id;
    const name = si.ingredient.name;
    const need = si.amounts[0] ?? null;
    if (!need) {
      return {
        ingredientId,
        name,
        need: null,
        basisUnit: null,
        needValue: null,
        haveValue: null,
        status: "missing",
      };
    }

    // Each product carries its own unit mappings (density/price/etc.) and its
    // own on-hand entries; weight conversion must use the matching product's.
    const products = (ingMap.get(ingredientId)?.product ?? []).map((p) => ({
      mappings: getAllUnitMappingsFromProduct(p),
      amounts: inventoryByProduct.get(p.id) ?? [],
    }));
    const anyEntries = products.some((p) => p.amounts.length > 0);

    // Prefer a grams basis; fall back to the recipe's own unit if the need has
    // no weight path (e.g. a count item whose product has only a price mapping).
    const allMappings = products.flatMap((p) => p.mappings);
    const needWeight = safeConvertAmount(need, allMappings, "weight");
    const basisUnit = needWeight.isOk() ? needWeight.value.unit : need.unit;
    const needValue = needWeight.isOk() ? needWeight.value.value : need.value;

    let haveTotal = 0;
    let anyConvertible = false;
    for (const product of products) {
      for (const onHand of product.amounts) {
        if (needWeight.isOk()) {
          const grams = safeConvertAmount(onHand, product.mappings, "weight");
          if (grams.isOk()) {
            haveTotal += grams.value.value;
            anyConvertible = true;
          }
        } else if (onHand.unit === need.unit) {
          haveTotal += onHand.value;
          anyConvertible = true;
        }
      }
    }

    return {
      ingredientId,
      name,
      need,
      basisUnit,
      needValue,
      haveValue: anyConvertible ? haveTotal : null,
      status: resolveStatus(needValue, haveTotal, anyEntries, anyConvertible),
    };
  }
}

const resolveStatus = (
  needValue: number,
  haveTotal: number,
  anyEntries: boolean,
  anyConvertible: boolean,
): IngredientAvailabilityStatus => {
  if (!anyEntries) return "missing";
  if (!anyConvertible) return "unconvertible";
  if (haveTotal + COVERAGE_EPSILON >= needValue) return "ok";
  if (haveTotal > 0) return "short";
  return "missing";
};

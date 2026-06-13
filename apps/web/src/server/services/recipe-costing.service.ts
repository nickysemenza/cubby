/**
 * Server-side recipe cost/calorie rollup. Computes the same totals the client
 * used to (reusing `calculateTotals` + the ingredient USDA enrichment) and
 * persists them on `Recipe.totals`, so the list reads them directly instead of
 * fetching every ingredient and running WASM per page load.
 *
 * Freshness is event-driven: writes null `totalsComputedAt` on the affected rows
 * (see repo/recipe/totals + the recipe/product write paths); this service's
 * `drainStale` recomputes them, driven by the client while the app is open.
 */

import type { RecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeCostingExplain,
  RecipeOut,
  RecipeTotals,
} from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { keyBy } from "es-toolkit";
import {
  type CalculateTotalsResult,
  type CostingRow,
  computeRecipeCosting,
  flattenSections,
} from "~/lib/recipe-costing";
import {
  collectIngredientIds,
  collectSubRecipeIds,
  getRecipeIngredientName,
} from "~/lib/recipe-graph";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getRecipesByIDs } from "~/server/repo/recipe/crud";
import {
  countStaleRecipes,
  findParentRecipeIds,
  getRecipeTotalsState,
  markRecipesStale,
  selectAllActiveRecipeIds,
  selectStaleRecipeIds,
  updateRecipeTotals,
} from "~/server/repo/recipe/totals";
import type {
  IngredientService,
  IngredientWithFoodOut,
} from "./ingredient.service";

const toRecipeTotals = (t: CalculateTotalsResult): RecipeTotals => ({
  costTotal: t.price,
  caloriesTotal: getNutrientValueByKey(t.nutrients, "kcal") ?? 0,
  ingredientCount: t.totalIngredients,
  costCovered: t.totalIngredients - t.missingByType.price.length,
  caloriesCovered: t.totalIngredients - t.missingByType.nutrients.length,
});

/**
 * Products with a confirmed USDA match (`ndb_number`) whose food failed to
 * resolve — a transient backend miss, not real no-data. Doubles as the
 * completeness predicate (empty ⇒ complete) and the named list the explain
 * payload surfaces.
 */
const usdaMissesFor = (
  rows: CostingRow[],
  ingMap: Record<string, IngredientWithFoodOut>,
): { ingredientName: string; productName: string; ndbNumber: number }[] => {
  const misses: {
    ingredientName: string;
    productName: string;
    ndbNumber: number;
  }[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.type !== "ingredient" || seen.has(row.ingredient.id)) continue;
    seen.add(row.ingredient.id);
    const entry = ingMap[row.ingredient.id];
    for (const p of entry?.product ?? []) {
      if (p.ndb_number != null && p.food == null) {
        misses.push({
          ingredientName: entry?.name ?? row.ingredient.name,
          productName: p.name,
          ndbNumber: p.ndb_number,
        });
      }
    }
  }
  return misses;
};

export class RecipeCostingService {
  constructor(
    private db: Database,
    private ingredientService: IngredientService,
  ) {}

  /**
   * Load everything a costing pass needs for these recipes: the transitive
   * closure of sub-recipes (recipe-as-ingredient, cycle-guarded) and the
   * USDA-enriched ingredient map.
   */
  private async loadContext(recipes: RecipeOut[]): Promise<{
    ingMap: Record<string, IngredientWithFoodOut>;
    recipeMap: Record<string, RecipeOut>;
  }> {
    const recipeMap: Record<string, RecipeOut> = {};
    const seen = new Set<string>();
    let frontier = collectSubRecipeIds(recipes);
    while (frontier.length > 0) {
      const toFetch = frontier.filter((id) => !seen.has(id));
      for (const id of toFetch) seen.add(id);
      if (toFetch.length === 0) break;
      const fetched = await getRecipesByIDs(this.db, toFetch);
      frontier = [];
      for (const r of fetched) {
        recipeMap[r.id] = r;
        frontier.push(...collectSubRecipeIds([r]));
      }
    }

    const ingredientIds = collectIngredientIds([
      ...recipes,
      ...Object.values(recipeMap),
    ]);
    const ingredients =
      await this.ingredientService.getIngredientsByIDs(ingredientIds);
    const ingMap = keyBy(ingredients, (i) => i.id);
    return { ingMap, recipeMap };
  }

  /**
   * Compute totals for the given (fully-loaded) recipes. `complete` is false
   * when a USDA lookup that should have resolved (a product with an
   * `ndb_number`) came back null — a transient backend miss the caller should
   * retry rather than bake in.
   */
  async computeTotals(
    recipes: RecipeOut[],
  ): Promise<Map<RecipeId, { totals: RecipeTotals; complete: boolean }>> {
    const { ingMap, recipeMap } = await this.loadContext(recipes);

    // One engine call for the whole batch (ingredients serialized once).
    const costings = computeRecipeCosting(
      recipes,
      ingMap,
      getRecipeIngredientName,
      recipeMap,
    );

    const result = new Map<
      RecipeId,
      { totals: RecipeTotals; complete: boolean }
    >();
    for (const r of recipes) {
      const costing = costings.get(r.id);
      if (!costing) continue;
      result.set(r.id as RecipeId, {
        complete:
          usdaMissesFor(flattenSections(r.sections), ingMap).length === 0,
        totals: toRecipeTotals(costing.totals),
      });
    }
    return result;
  }

  /**
   * Full costing explanation for one recipe: the persisted state (totals,
   * computed-at, staleness), a fresh compute with per-row diagnostics enriched
   * with unit-graph conversion paths, named USDA misses, and persisted-vs-live
   * drift. Read-only — never stamps or recomputes persisted state.
   */
  async explainRecipe(recipeId: RecipeId): Promise<RecipeCostingExplain> {
    const [state, recipes] = await Promise.all([
      getRecipeTotalsState(this.db, recipeId),
      getRecipesByIDs(this.db, [recipeId]),
    ]);
    const recipe = recipes[0];
    if (!state || !recipe) {
      throw createAppError("RECIPE_NOT_FOUND", "Recipe not found");
    }

    const { ingMap, recipeMap } = await this.loadContext([recipe]);
    const rows = flattenSections(recipe.sections);
    // Explain mode: the engine attaches the unit-graph route per measure to
    // each row's diagnostic — the "show your work" that makes a wrong number
    // self-explanatory — driven by the row's own amount or its estimated grams.
    const costing = computeRecipeCosting(
      [recipe],
      ingMap,
      getRecipeIngredientName,
      recipeMap,
      { explain: true },
    ).get(recipe.id);
    if (!costing) {
      throw createAppError("RECIPE_NOT_FOUND", "Recipe could not be costed");
    }
    const computedTotals = toRecipeTotals(costing.totals);
    const usdaMisses = usdaMissesFor(rows, ingMap);
    const diagnostics = costing.totals.diagnostics;

    const persisted = state.totals;
    const drift = {
      cost:
        persisted != null &&
        Math.abs(persisted.costTotal - computedTotals.costTotal) > 0.005,
      calories:
        persisted != null &&
        Math.abs(persisted.caloriesTotal - computedTotals.caloriesTotal) > 0.5,
    };

    return {
      persisted: {
        totals: state.totals,
        totalsComputedAt: state.totalsComputedAt,
        stale: state.totalsComputedAt == null,
      },
      computed: {
        totals: computedTotals,
        complete: usdaMisses.length === 0,
        diagnostics,
        usdaMisses,
      },
      drift,
    };
  }

  /**
   * Recompute + persist totals for the given recipe ids. When a recipe's totals
   * actually change, nulls its direct parents so multi-level sub-recipe changes
   * converge over drain passes (no recursive walk on the write path).
   */
  async recompute(recipeIds: RecipeId[]): Promise<void> {
    if (recipeIds.length === 0) return;
    const recipes = await getRecipesByIDs(this.db, recipeIds);
    const totalsMap = await this.computeTotals(recipes);
    const changedParents = new Set<RecipeId>();
    for (const r of recipes) {
      const computed = totalsMap.get(r.id as RecipeId);
      if (!computed) continue;
      const { totals: next, complete } = computed;
      // Write the best-effort blob always; only stamp fresh when complete, so an
      // incomplete (transient USDA miss) recompute stays stale and gets retried.
      await updateRecipeTotals(this.db, r.id as RecipeId, next, {
        stale: !complete,
      });
      const changed =
        !r.totals ||
        r.totals.costTotal !== next.costTotal ||
        r.totals.caloriesTotal !== next.caloriesTotal;
      if (complete && changed) {
        for (const p of await findParentRecipeIds(this.db, r.id as RecipeId))
          changedParents.add(p);
      }
    }
    // Don't re-stale a recipe we just computed in this batch.
    for (const id of recipeIds) changedParents.delete(id);
    await markRecipesStale(this.db, [...changedParents]);
  }

  /** Recompute one batch of stale recipes; report how many remain. */
  async drainStale(
    limit: number,
  ): Promise<{ processed: number; remaining: number }> {
    const ids = await selectStaleRecipeIds(this.db, limit);
    await this.recompute(ids);
    const remaining = await countStaleRecipes(this.db);
    if (ids.length > 0) {
      // Visible in `wrangler tail` / the dev terminal — the drain's only trace.
      console.log(
        `[recipe-totals] drained ${ids.length} (${remaining} remaining)`,
      );
    }
    return { processed: ids.length, remaining };
  }

  /**
   * Recompute every recipe's totals regardless of stale state. One-shot backfill
   * / admin recovery (e.g. after the USDA backend was unavailable during a drain).
   * Chunked so a large library doesn't hold one giant transaction.
   */
  async recomputeAll(): Promise<{ processed: number }> {
    const ids = await selectAllActiveRecipeIds(this.db);
    const CHUNK = 25;
    for (let i = 0; i < ids.length; i += CHUNK) {
      await this.recompute(ids.slice(i, i + CHUNK));
    }
    console.log(`[recipe-totals] recomputeAll processed ${ids.length}`);
    return { processed: ids.length };
  }
}

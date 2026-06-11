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
import type { RecipeOut, RecipeTotals } from "@cubby/schemas/recipe";
import { getNutrientValueByKey } from "@cubby/usda-schemas";
import { calculateTotals } from "~/lib/recipe-costing";
import type { Database } from "~/server/db";
import { getRecipesByIDs } from "~/server/repo/recipe/crud";
import {
  countStaleRecipes,
  findParentRecipeIds,
  markRecipesStale,
  selectAllActiveRecipeIds,
  selectStaleRecipeIds,
  updateRecipeTotals,
} from "~/server/repo/recipe/totals";
import type { IngredientService } from "./ingredient.service";

// Local (server-safe) name getter — avoids importing the client recipe-utils.
const recipeIngredientName = (
  i: RecipeOut["sections"][number]["ingredients"][number],
) => (i.type === "ingredient" ? i.ingredient.name : i.recipe.name);

const collectIngredientIds = (recipes: RecipeOut[]): string[] => {
  const ids = new Set<string>();
  for (const r of recipes)
    for (const s of r.sections)
      for (const i of s.ingredients)
        if (i.type === "ingredient") ids.add(i.ingredient.id);
  return [...ids];
};

const collectSubRecipeIds = (recipes: RecipeOut[]): RecipeId[] => {
  const ids = new Set<string>();
  for (const r of recipes)
    for (const s of r.sections)
      for (const i of s.ingredients)
        if (i.type === "recipe") ids.add(i.recipe.id);
  return [...ids] as RecipeId[];
};

export class RecipeCostingService {
  constructor(
    private db: Database,
    private ingredientService: IngredientService,
  ) {}

  /**
   * Compute totals for the given (fully-loaded) recipes. Resolves the transitive
   * closure of sub-recipes and the USDA-enriched ingredient map, then runs
   * `calculateTotals` per recipe. `complete` is false when a USDA lookup that
   * should have resolved (a product with an `ndb_number`) came back null —
   * signalling a transient backend miss the caller should retry rather than bake in.
   */
  async computeTotals(
    recipes: RecipeOut[],
  ): Promise<Map<RecipeId, { totals: RecipeTotals; complete: boolean }>> {
    // Transitive closure of sub-recipes (recipe-as-ingredient), so nested
    // cost/calories roll up. Cycle-guarded by the seen set.
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
    ]) as Parameters<IngredientService["getIngredientsByIDs"]>[0];
    const ingredients =
      await this.ingredientService.getIngredientsByIDs(ingredientIds);
    const ingMap = Object.fromEntries(ingredients.map((i) => [i.id, i]));

    // A product with an `ndb_number` (a confirmed USDA match) that resolved to
    // null food = a transient backend miss, not real no-data. If any of a recipe's
    // ingredients hit that, its compute is "incomplete" → don't stamp it fresh.
    const ingredientResolvedOk = (ingredientId: string): boolean => {
      const products = ingMap[ingredientId]?.product ?? [];
      return !products.some((p) => p.ndb_number != null && p.food == null);
    };

    const result = new Map<
      RecipeId,
      { totals: RecipeTotals; complete: boolean }
    >();
    for (const r of recipes) {
      const ings = r.sections.flatMap((s) => s.ingredients);
      const t = calculateTotals(ings, ingMap, recipeIngredientName, recipeMap);
      const complete = ings.every(
        (i) => i.type !== "ingredient" || ingredientResolvedOk(i.ingredient.id),
      );
      result.set(r.id as RecipeId, {
        complete,
        totals: {
          costTotal: t.price,
          caloriesTotal: getNutrientValueByKey(t.nutrients, "kcal") ?? 0,
          ingredientCount: t.totalIngredients,
          costCovered: t.totalIngredients - t.missingByType.price.length,
          caloriesCovered:
            t.totalIngredients - t.missingByType.nutrients.length,
        },
      });
    }
    return result;
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
    return { processed: ids.length };
  }
}

import type { WAvailabilityGroup } from "@cubby/recipebridge";
import type {
  AggregatedNeed,
  IngredientAvailability,
  RecipeAvailability,
} from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import {
  type IngredientId,
  type IngredientShortcode,
  type ProductId,
  type ProductShortcode,
  type RecipeId,
  type RecipeShortcode,
  unsafeProductId,
} from "@cubby/schemas/identifiers";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type { SectionIngredientOut } from "@cubby/schemas/recipe";
import { uniq } from "es-toolkit";
import {
  evaluateAvailability,
  toWAmount,
  toWProductInput,
} from "~/lib/recipe-costing";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getInventoryForProducts } from "~/server/repo/inventory";
import { getRecipeByID } from "~/server/repo/recipe";
import {
  resolveAllPresent,
  resolveLiveShortcodes,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import type { USDAClient } from "../clients/usda";
import { getIngredientsByIDs } from "./ingredient.service";

const resolveProductIds = async (
  db: Database,
  shortcodes: ProductShortcode[],
): Promise<{
  ids: ProductId[];
  shortcodeById: Map<ProductId, ProductShortcode>;
}> => {
  const resolved = await resolveLiveShortcodes(db, shortcodes, "product");
  const ids = shortcodes.flatMap((shortcode) => {
    const id = resolved.get(shortcode);
    return id ? [unsafeProductId(id)] : [];
  });
  return {
    ids,
    shortcodeById: new Map(
      shortcodes.flatMap((shortcode) => {
        const id = resolved.get(shortcode);
        return id ? [[unsafeProductId(id), shortcode] as const] : [];
      }),
    ),
  };
};

const resolveIngredientIds = async (
  db: Database,
  shortcodes: IngredientShortcode[],
): Promise<IngredientId[]> => resolveAllPresent(db, "ingredient", shortcodes);

// Output types live in @cubby/schemas/availability (single source of
// truth, shared with the suggestions router's .output()).

/**
 * Cross-references a recipe's ingredients against current inventory, reconciling
 * units through each linked product's unit mappings, to answer "do I have what
 * this recipe needs, and what am I short?".
 *
 * The gram-first reconciliation + status verdict run in Rust (recipebridge's
 * availability module, sharing the costing engine's conversion kernel): grams
 * basis whenever every need converts to weight, else the authored unit; mixed
 * units with no weight basis surface as `unconvertible` rather than a bogus
 * total. This service owns the DB loads and shapes the batched WASM result.
 *
 * This is the shared engine behind "what can I make?", the find_cookable_recipes
 * agent tool, and the meal-planning shopping list.
 */
export class AvailabilityService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async getRecipeAvailability(
    recipeShortcode: RecipeShortcode,
  ): Promise<RecipeAvailability> {
    const recipeId = await resolveOrThrow(this.db, "recipe", recipeShortcode);
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
    const ingredientEntries = await getIngredientsByIDs(
      this.db,
      this.usdaClient,
      await resolveIngredientIds(this.db, directIds),
    );
    const ingMap = new Map<IngredientShortcode, IngredientWithFoodLeanOut>(
      ingredientEntries.map((ing) => [ing.id, ing]),
    );

    // One batched inventory read across every product of every ingredient.
    const productIds = uniq(
      ingredientEntries.flatMap((ing) => ing.product.map((p) => p.id)),
    );
    const resolvedProducts = await resolveProductIds(this.db, productIds);
    const inventory = await getInventoryForProducts(
      this.db,
      resolvedProducts.ids,
    );
    const inventoryByProduct = new Map<string, Amount[]>();
    for (const { productId, amount } of inventory) {
      const publicId = resolvedProducts.shortcodeById.get(productId);
      if (!publicId) continue;
      const list = inventoryByProduct.get(publicId);
      if (list) list.push(amount);
      else inventoryByProduct.set(publicId, [amount]);
    }

    // One availability group per resolvable ingredient row. Sub-recipes and
    // amount-less rows are resolved directly below (never sent to WASM); the
    // group key is the row's index, so results zip back in order.
    const groups: WAvailabilityGroup[] = [];
    sectionIngredients.forEach((si, idx) => {
      if (si.type !== "ingredient") return;
      const need = si.amounts[0];
      if (!need) return;
      const products = (ingMap.get(si.ingredient.id)?.product ?? []).map(
        (p) => ({
          product: toWProductInput(p),
          on_hand: (inventoryByProduct.get(p.id) ?? []).map(toWAmount),
        }),
      );
      groups.push({
        key: String(idx),
        needs: [{ amount: toWAmount(need), line_index: 0 }],
        products,
      });
    });
    const byKey = new Map(
      (groups.length ? evaluateAvailability({ groups }).groups : []).map(
        (g) => [g.key, g] as const,
      ),
    );

    const ingredients = sectionIngredients.map(
      (si, idx): IngredientAvailability => {
        // Sub-recipes aren't expanded in v1 — flagged, excluded from coverage.
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
        const need = si.amounts[0] ?? null;
        if (!need) {
          return {
            ingredientId: si.ingredient.id,
            name: si.ingredient.name,
            need: null,
            basisUnit: null,
            needValue: null,
            haveValue: null,
            status: "missing",
          };
        }
        const g = byKey.get(String(idx));
        return {
          ingredientId: si.ingredient.id,
          name: si.ingredient.name,
          need,
          basisUnit: g?.basis_unit ?? need.unit,
          needValue: g?.need_value ?? need.value,
          haveValue: g?.have_value ?? null,
          status: g?.status ?? "missing",
        };
      },
    );

    const resolvable = ingredients.filter((i) => i.status !== "subrecipe");
    const available = resolvable.filter((i) => i.status === "ok");

    return {
      recipeId: recipe.id,
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
      ingredientId: IngredientShortcode;
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
    const ingredientEntries = await getIngredientsByIDs(
      this.db,
      this.usdaClient,
      await resolveIngredientIds(this.db, distinctIngredientIds),
    );
    const ingMap = new Map<IngredientShortcode, IngredientWithFoodLeanOut>(
      ingredientEntries.map((ing) => [ing.id, ing]),
    );
    const productIds = uniq(
      ingredientEntries.flatMap((ing) => ing.product.map((p) => p.id)),
    );
    const resolvedProducts = await resolveProductIds(this.db, productIds);
    const inventory = await getInventoryForProducts(
      this.db,
      resolvedProducts.ids,
    );
    const inventoryByProduct = new Map<string, Amount[]>();
    for (const { productId, amount } of inventory) {
      const publicId = resolvedProducts.shortcodeById.get(productId);
      if (!publicId) continue;
      const list = inventoryByProduct.get(publicId);
      if (list) list.push(amount);
      else inventoryByProduct.set(publicId, [amount]);
    }

    // Group contributions by ingredient and evaluate each once.
    const byIngredient = new Map<IngredientShortcode, Contribution[]>();
    for (const c of contributions) {
      const list = byIngredient.get(c.ingredientId);
      if (list) list.push(c);
      else byIngredient.set(c.ingredientId, [c]);
    }

    // One group per ingredient: every contributing need (carrying its lineIndex)
    // against the ingredient's products + on-hand (counted once). Reconciled in
    // one WASM call; results zip back by ingredient id.
    const groups: WAvailabilityGroup[] = Array.from(byIngredient.entries()).map(
      ([ingredientId, contribs]) => ({
        key: ingredientId,
        needs: contribs.map((c) => ({
          amount: toWAmount(c.scaledNeed),
          line_index: c.lineIndex,
        })),
        products: (ingMap.get(ingredientId)?.product ?? []).map((p) => ({
          product: toWProductInput(p),
          on_hand: (inventoryByProduct.get(p.id) ?? []).map(toWAmount),
        })),
      }),
    );
    const byKey = new Map(
      (groups.length ? evaluateAvailability({ groups }).groups : []).map(
        (g) => [g.key, g] as const,
      ),
    );

    return Array.from(byIngredient.entries()).map(
      ([ingredientId, contribs]): AggregatedNeed => {
        const g = byKey.get(ingredientId);
        return {
          ingredientId,
          name: contribs[0]?.name ?? "",
          basisUnit: g?.basis_unit ?? contribs[0]?.scaledNeed.unit ?? null,
          needValue: g?.need_value ?? 0,
          haveValue: g?.have_value ?? null,
          status: g?.status ?? "missing",
          sources: g
            ? g.sources.map((s) => ({
                lineIndex: s.line_index,
                needValue: s.need_value,
              }))
            : contribs.map((c) => ({
                lineIndex: c.lineIndex,
                needValue: c.scaledNeed.value,
              })),
        };
      },
    );
  }
}

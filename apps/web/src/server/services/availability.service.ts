import type {
  WAvailabilityGroup,
  WAvailabilityGroupResult,
  WNeedsRecipe,
} from "@cubby/recipebridge";
import type {
  AggregatedNeed,
  BlockedSubRecipe,
  IngredientAvailability,
  NeedVia,
  RecipeAvailability,
} from "@cubby/schemas/availability";
import type { Amount } from "@cubby/schemas/codec";
import {
  type IngredientId,
  type IngredientShortcode,
  type ProductId,
  type ProductShortcode,
  type RecipeShortcode,
  unsafeIngredientShortcode,
  unsafeProductId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import type { IngredientWithFoodLeanOut } from "@cubby/schemas/ingredient";
import type { RecipeGraphOut } from "@cubby/schemas/recipe";
import { uniq } from "es-toolkit";
import {
  evaluateAvailability,
  expandRecipeNeeds,
  fromWAmount,
  toWAmount,
  toWProductInput,
} from "~/lib/recipe-costing";
import { getRecipeIngredientName } from "~/lib/recipe-graph";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { getInventoryForProducts } from "~/server/repo/inventory";
import {
  getRecipesByIDs,
  getSubRecipeClosure,
} from "~/server/repo/recipe/crud";
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

/** One planned recipe to make, at a scale. */
export type PlannedLine = { recipeId: RecipeShortcode; scale: number };

/** One ingredient need produced by one planned line. */
type NeedContribution = {
  ingredientId: IngredientShortcode;
  name: string;
  /** `null` for an amount-less line ("salt, to taste"). */
  amount: Amount | null;
  lineIndex: number;
  via: NeedVia[];
};

/** A contribution the evaluator can actually score. */
type AmountedContribution = NeedContribution & { amount: Amount };

type NeedGroup = {
  ingredientId: IngredientShortcode;
  name: string;
  /**
   * Contributions carrying an amount, in the order they were sent to WASM —
   * positionally 1:1 with `result.sources`.
   */
  contributions: AmountedContribution[];
  /** Absent when this ingredient was only ever mentioned without an amount. */
  result: WAvailabilityGroupResult | undefined;
};

type EvaluatedNeeds = {
  /** One entry per distinct ingredient, in first-appearance order. */
  groups: NeedGroup[];
  blocked: BlockedSubRecipe[];
  rootsByShortcode: Map<RecipeShortcode, RecipeGraphOut>;
};

const toWNeedsRecipe = (recipe: RecipeGraphOut): WNeedsRecipe => ({
  id: recipe.id,
  name: recipe.name,
  // `recipeYieldSchema` is {value, unit} — structurally a WAmount already.
  recipe_yield: recipe.yield ?? null,
  rows: recipe.sections.flatMap((section) =>
    section.ingredients.map((si) => ({
      kind:
        si.type === "recipe" ? ("recipe" as const) : ("ingredient" as const),
      target_id: si.type === "recipe" ? si.recipe.id : si.ingredient.id,
      name: getRecipeIngredientName(si),
      amounts: si.amounts.map(toWAmount),
    })),
  ),
});

const toVia = (via: { recipe_id: string; name: string }[]): NeedVia[] =>
  via.map((v) => ({
    recipeId: unsafeRecipeShortcode(v.recipe_id),
    name: v.name,
  }));

// Output types live in @cubby/schemas/availability (single source of
// truth, shared with the suggestions router's .output()).

/**
 * Cross-references planned recipes against current inventory, reconciling units
 * through each linked product's unit mappings, to answer "do I have what this
 * needs, and what am I short?".
 *
 * Sub-recipe expansion, gram-first reconciliation, and the status verdict all
 * run in Rust (recipebridge's `needs` + `availability` modules, sharing the
 * costing engine's conversion kernel). This service owns the DB loads and
 * shapes the batched WASM results.
 *
 * This is the shared engine behind "what can I make?", the find_cookable_recipes
 * agent tool, and the meal-planning shopping list.
 */
export class AvailabilityService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  /**
   * The shared core: planned lines → per-ingredient needs reconciled against
   * inventory, plus the sub-recipes that couldn't be expanded.
   *
   * Inventory is counted ONCE per ingredient. Summing per-line availability
   * would multiply on-hand by the number of recipes using it — the load-bearing
   * reason a shopping list isn't a sum of per-recipe availability calls, and
   * equally the reason a single recipe listing flour twice can't score each
   * mention against the whole shelf.
   */
  private async evaluateNeeds(lines: PlannedLine[]): Promise<EvaluatedNeeds> {
    const empty: EvaluatedNeeds = {
      groups: [],
      blocked: [],
      rootsByShortcode: new Map(),
    };
    if (lines.length === 0) return empty;

    const distinctRecipeIds = uniq(lines.map((l) => l.recipeId));
    const roots = await getRecipesByIDs(
      this.db,
      await resolveAllPresent(this.db, "recipe", distinctRecipeIds),
    );
    const rootsByShortcode = new Map(roots.map((r) => [r.id, r]));
    if (roots.length === 0) return empty;

    // Sub-recipe bodies aren't on the parent (a `recipe` row carries only a
    // pointer + metadata), so the closure has to be fetched before expansion.
    const closure = await getSubRecipeClosure(this.db, roots);

    const expanded = expandRecipeNeeds({
      // Only lines whose recipe actually loaded: a deleted recipe is skipped
      // here rather than erroring, matching the previous behavior.
      lines: lines.flatMap((line, lineIndex) =>
        rootsByShortcode.has(line.recipeId)
          ? [
              {
                recipe_id: line.recipeId,
                scale: line.scale,
                line_index: lineIndex,
              },
            ]
          : [],
      ),
      recipes: [...roots, ...Object.values(closure)].map(toWNeedsRecipe),
    });

    const contributions: NeedContribution[] = expanded.needs.map((n) => ({
      ingredientId: unsafeIngredientShortcode(n.ingredient_id),
      name: n.name,
      amount: n.amount ? fromWAmount(n.amount) : null,
      lineIndex: n.line_index,
      via: toVia(n.via),
    }));

    const blocked: BlockedSubRecipe[] = expanded.blocked.map((b) => ({
      recipeId: unsafeRecipeShortcode(b.recipe_id),
      name: b.name,
      reason: b.reason,
      amount: b.amount ? fromWAmount(b.amount) : null,
      via: toVia(b.via),
      lineIndex: b.line_index,
    }));

    if (contributions.length === 0) {
      return { groups: [], blocked, rootsByShortcode };
    }

    // Load each distinct ingredient (food-enriched, for density mappings) + one
    // batched inventory read across all their products. The id set already
    // includes ingredients reached through sub-recipes, because the expansion
    // walked the closure for us.
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

    // Group by ingredient, preserving first-appearance order.
    const byIngredient = new Map<IngredientShortcode, NeedContribution[]>();
    for (const c of contributions) {
      const list = byIngredient.get(c.ingredientId);
      if (list) list.push(c);
      else byIngredient.set(c.ingredientId, [c]);
    }

    const evaluable = Array.from(byIngredient.entries()).map(
      ([ingredientId, all]) => ({
        ingredientId,
        all,
        withAmount: all.filter(
          (c): c is AmountedContribution => c.amount != null,
        ),
      }),
    );

    const groupsInput: WAvailabilityGroup[] = evaluable
      .filter((g) => g.withAmount.length > 0)
      .map((g) => ({
        key: g.ingredientId,
        needs: g.withAmount.map((c) => ({
          amount: toWAmount(c.amount),
          line_index: c.lineIndex,
        })),
        products: (ingMap.get(g.ingredientId)?.product ?? []).map((p) => ({
          product: toWProductInput(p),
          on_hand: (inventoryByProduct.get(p.id) ?? []).map(toWAmount),
        })),
      }));

    const byKey = new Map(
      (groupsInput.length
        ? evaluateAvailability({ groups: groupsInput }).groups
        : []
      ).map((g) => [g.key, g] as const),
    );

    return {
      groups: evaluable.map(({ ingredientId, all, withAmount }) => ({
        ingredientId,
        name: all[0]?.name ?? "",
        contributions: withAmount,
        result: byKey.get(ingredientId),
      })),
      blocked,
      rootsByShortcode,
    };
  }

  async getRecipeAvailability(
    recipeShortcode: RecipeShortcode,
  ): Promise<RecipeAvailability> {
    // Resolve first so a missing recipe 404s rather than returning an empty
    // availability that reads as "nothing needed".
    await resolveOrThrow(this.db, "recipe", recipeShortcode);
    const { groups, blocked, rootsByShortcode } = await this.evaluateNeeds([
      { recipeId: recipeShortcode, scale: 1 },
    ]);
    const recipe = rootsByShortcode.get(recipeShortcode);
    if (!recipe) {
      throw createAppError(
        "RECIPE_NOT_FOUND",
        `Recipe ${recipeShortcode} not found`,
      );
    }

    const ingredients: IngredientAvailability[] = groups.map((g) => {
      const first = g.contributions[0];
      if (!first) {
        // Named with no amount anywhere ("to taste") — unscoreable, and
        // reported as missing exactly as it was before expansion.
        return {
          ingredientId: g.ingredientId,
          name: g.name,
          need: null,
          basisUnit: null,
          needValue: null,
          haveValue: null,
          status: "missing",
          via: [],
          blockedReason: null,
        };
      }
      return {
        ingredientId: g.ingredientId,
        name: g.name,
        // A single contribution still has a meaningful written amount; several
        // (the same ingredient reached by two routes) do not.
        need: g.contributions.length === 1 ? first.amount : null,
        basisUnit: g.result?.basis_unit ?? first.amount.unit,
        needValue: g.result?.need_value ?? first.amount.value,
        haveValue: g.result?.have_value ?? null,
        status: g.result?.status ?? "missing",
        via: first.via,
        blockedReason: null,
      };
    });

    // A sub-recipe we couldn't expand becomes its own row, so the panel names
    // what's missing instead of quietly scoring the recipe as complete.
    const blockedRows: IngredientAvailability[] = blocked.map((b) => ({
      ingredientId: null,
      name: b.name,
      need: b.amount,
      basisUnit: null,
      needValue: null,
      haveValue: null,
      status: "subrecipe",
      via: b.via,
      blockedReason: b.reason,
    }));

    const rows = [...ingredients, ...blockedRows];
    const resolvable = rows.filter((i) => i.status !== "subrecipe");
    const available = resolvable.filter((i) => i.status === "ok");

    return {
      recipeId: recipe.id,
      recipeName: recipe.name,
      coverage:
        resolvable.length === 0 ? 1 : available.length / resolvable.length,
      totalIngredients: resolvable.length,
      availableIngredients: available.length,
      ingredients: rows,
      missing: resolvable.filter((i) => i.status !== "ok").map((i) => i.name),
      unexpandedSubRecipes: blockedRows.length,
    };
  }

  /**
   * Aggregate ingredient needs across many planned recipes (the meal-planning
   * shopping list). Each line is a recipe to make at a scale; needs are scaled
   * and summed per ingredient, sub-recipes expanded by yield.
   *
   * `sources[].lineIndex` indexes back into `lines`, so the caller can
   * attribute each contribution to its meal/recipe; `sources[].via` names the
   * sub-recipe chain it came through.
   */
  async getAggregatedNeeds(lines: PlannedLine[]): Promise<{
    needs: AggregatedNeed[];
    unexpanded: BlockedSubRecipe[];
  }> {
    const { groups, blocked } = await this.evaluateNeeds(lines);

    const needs = groups.flatMap((g): AggregatedNeed[] => {
      // An ingredient mentioned only without an amount contributes no need to
      // a shopping list — there's nothing to buy a quantity of.
      if (g.contributions.length === 0) return [];
      const first = g.contributions[0];
      return [
        {
          ingredientId: g.ingredientId,
          name: g.name,
          basisUnit: g.result?.basis_unit ?? first?.amount.unit ?? null,
          needValue: g.result?.need_value ?? 0,
          haveValue: g.result?.have_value ?? null,
          status: g.result?.status ?? "missing",
          shortfall: g.result?.shortfall ?? null,
          // `evaluate_group` builds `sources` positionally 1:1 with the needs
          // it was handed (including under an incoherent basis, which zeroes
          // the values but keeps the vector), so zip by INDEX. lineIndex is no
          // longer unique within a group — one line can reach the same
          // ingredient both directly and through a sub-recipe.
          sources: (g.result?.sources ?? []).flatMap((s, i) => {
            const c = g.contributions[i];
            return c
              ? [
                  {
                    lineIndex: s.line_index,
                    needValue: s.need_value,
                    via: c.via,
                  },
                ]
              : [];
          }),
        },
      ];
    });

    return { needs, unexpanded: blocked };
  }
}

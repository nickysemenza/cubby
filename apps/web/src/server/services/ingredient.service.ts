import type {
  IngredientId,
  IngredientShortcode,
  RecipeId,
} from "@cubby/schemas/identifiers";
import type {
  EnrichmentRow,
  IngredientWithFoodLeanOut,
  IngredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import type {
  ProductWithMappingsOut as ProductWithMappings,
  ProductWithMappingsAndFoodOut,
} from "@cubby/schemas/product";

import { conversionCoverage, gradedKinds } from "~/lib/conversion-coverage";
import { classifyIngredientFix } from "~/lib/recipe-totals-gaps";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
// Extended schemas that include food data
import type { Database } from "~/server/db";

import type { USDAClient } from "../clients/usda";
import {
  enrichmentWorkbenchIngredients as enrichmentWorkbenchIngredientsRepo,
  findFuzzyMergeCandidates,
  getIngredientByID as getIngredientByIDRepo,
  getIngredientByName as getIngredientByNameRepo,
  getIngredientsByIDsLean as getIngredientsByIDsLeanRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
import { recipeTreeLeafIngredientIds } from "../repo/recipe/totals";
import { TraceNames, withTrace } from "../tracing";
import { batchEnrichNestedItems, batchEnrichWithFood } from "./usda-helpers";

const enrichProductsWithFood = async (
  usdaClient: USDAClient,
  products: ProductWithMappings[],
): Promise<ProductWithMappingsAndFoodOut[]> => {
  return batchEnrichWithFood(products, foodLookupParamFromProduct, usdaClient);
};

export const getIngredientByID = async (
  db: Database,
  usdaClient: USDAClient,
  id: IngredientId,
): Promise<IngredientWithFoodOut> => {
  const ingredient = await getIngredientByIDRepo(db, id);
  const enrichedProducts = await enrichProductsWithFood(
    usdaClient,
    ingredient.product,
  );

  return {
    ...ingredient,
    product: enrichedProducts,
  };
};

/**
 * Batched `getIngredientByID`: one DB query for all ids + one cross-ingredient
 * USDA enrichment pass (via batchEnrichNestedItems), instead of N×(query+enrich).
 * Used by the recipe-costing path (recompute / getManyByIDs) + the unit-mapping
 * analysis — all of which only read products/food, so this is the LEAN fetch: no
 * recipe-usage relation (the per-usage Recipe + Section jsonb bodies that the
 * full ingredient graph carries — a needless over-fetch for costing).
 */
export const getIngredientsByIDs = async (
  db: Database,
  usdaClient: USDAClient,
  ids: IngredientId[],
): Promise<IngredientWithFoodLeanOut[]> => {
  return withTrace(
    TraceNames.service("ingredient", "getIngredientsByIDs"),
    async (span) => {
      span.setAttribute("ingredient.requested_count", ids.length);
      const ingredients = await getIngredientsByIDsLeanRepo(db, ids);
      return batchEnrichNestedItems(
        ingredients,
        (ing) => ing.product,
        (products) => enrichProductsWithFood(usdaClient, products),
        (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts }),
      );
    },
  );
};

export const getIngredientByName = async (
  db: Database,
  usdaClient: USDAClient,
  name: string,
): Promise<IngredientWithFoodOut | null> => {
  const ingredient = await getIngredientByNameRepo(db, name);
  if (!ingredient) return null;

  const enrichedProducts = await enrichProductsWithFood(
    usdaClient,
    ingredient.product,
  );

  return {
    ...ingredient,
    product: enrichedProducts,
  };
};

/**
 * The enrichment workbench worklist: every recipe-used ingredient that isn't
 * fully costable yet (no product, or a product whose conversion graph can't
 * reach all four base kinds), decorated with coverage + the recommended fix.
 *
 * Coverage/fix are computed here (WASM, not SQL-expressible) over the
 * USDA-enriched products. We scope to recipe-used ingredients up front so the
 * enrichment pass only hits the USDA network for products that matter, then
 * drop the fully-covered rows — the workbench is a list of gaps.
 */
export const enrichmentWorkbench = async (
  db: Database,
  usdaClient: USDAClient,
  opts?: {
    recipeId?: RecipeId;
    focusId?: IngredientId;
    focusShortcode?: IngredientShortcode;
  },
): Promise<EnrichmentRow[]> => {
  // Optional recipe scope: restrict the worklist to the leaf ingredients of one
  // recipe's sub-recipe tree, so the (expensive) USDA enrichment + fuzzy-merge
  // pass below only touches the ingredients that block that recipe's totals.
  const restrictToIds = opts?.recipeId
    ? await recipeTreeLeafIngredientIds(db, opts.recipeId)
    : opts?.focusId
      ? [opts.focusId]
      : undefined;
  // Lean fetch: recipe-used ingredients + products + recipeCount/cookbookOnly
  // scalars (no per-usage recipe bodies). The footer loads usages on demand.
  const candidates = await enrichmentWorkbenchIngredientsRepo(db, {
    restrictToIds,
  });

  const enriched = await batchEnrichNestedItems(
    candidates,
    (ing) => ing.product,
    (products) => enrichProductsWithFood(usdaClient, products),
    (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts }),
  );

  const rows = enriched.map((ing): EnrichmentRow => {
    // Grade against the kinds that apply to this ingredient — the user's N/A
    // opt-outs (naKinds) drop out, so a count-only item isn't pegged below
    // "complete" for a volume it's never measured by.
    const applicable = gradedKinds(ing.naKinds);
    const coverage = conversionCoverage(getIngredientMappings(ing), applicable);
    const recommendedFix = classifyIngredientFix({
      products: ing.product,
      coverage,
      applicable,
      // No recipe-line context here; default to a measured (package) price
      // suggestion — the inline editor still lets the user pick "each".
      sampleLineKind: "weight",
    });
    return {
      ...ing,
      coverage: {
        covered: [...coverage.covered],
        applicable,
        tier: coverage.tier,
      },
      recommendedFix,
      priceMode: "package",
      mergeCandidates: [],
    };
  });

  // Trigram near-duplicate hints (one self-join query; we look up only the
  // rows we show). Suggestion-only — the UI confirms before merging.
  // A report deep-link may intentionally focus a fully-covered row whose
  // existing graph conflicts with recipe-derived evidence. Keep that one row
  // visible even though ordinary browsing remains a gaps-only worklist.
  const worklist = rows.filter(
    (r) => r.recommendedFix !== "done" || r.id === opts?.focusShortcode,
  );
  const fuzzy = await findFuzzyMergeCandidates(db);
  return worklist.map((r) => ({
    ...r,
    mergeCandidates: fuzzy.get(r.id) ?? [],
  }));
};

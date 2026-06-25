import {
  ingredientWithRecipesAndProductOut,
  type ProductWithMappingsOut,
} from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import { type IngredientId, ingredientId } from "@cubby/schemas/identifiers";
import { type ingredientBase, ingredientOut } from "@cubby/schemas/ingredient";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { baseKind } from "@cubby/schemas/problems";
import { productTopLevelOut } from "@cubby/schemas/product";
import { unitMappingOut } from "@cubby/schemas/unitmapping";
import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import { conversionCoverage, gradedKinds } from "~/lib/conversion-coverage";
import { classifyIngredientFix } from "~/lib/recipe-costing-gaps";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
// Extended schemas that include food data
import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import {
  createIngredient as createIngredientRepo,
  enrichmentWorkbenchIngredients as enrichmentWorkbenchIngredientsRepo,
  findFuzzyMergeCandidates,
  getIngredientByID as getIngredientByIDRepo,
  getIngredientByName as getIngredientByNameRepo,
  getIngredientsByIDs as getIngredientsByIDsRepo,
  ingredientList as ingredientListRepo,
  mergeIngredients as mergeIngredientsRepo,
  updateIngredient as updateIngredientRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
import { TraceNames, withTrace } from "../tracing";
import { batchEnrichNestedItems, batchEnrichWithFood } from "./usda-helpers";

const productWithMappingsAndFoodOut = productTopLevelOut.extend({
  unitMappings: z.array(unitMappingOut),
  food: foodSummary.nullable(),
});

export type ProductWithMappingsAndFoodOut = z.infer<
  typeof productWithMappingsAndFoodOut
>;

export const ingredientWithFoodOut = ingredientWithRecipesAndProductOut.extend({
  product: z.array(productWithMappingsAndFoodOut),
});

export type IngredientWithFoodOut = z.infer<typeof ingredientWithFoodOut>;

/** The single highest-leverage fix for an ingredient, or "done" when complete. */
const enrichmentFixKind = z.enum([
  "no-product",
  "link-usda",
  "set-per-item-price",
  "add-purchase-mapping",
  "add-weight-mapping",
  "add-volume-mapping",
  "done",
]);

// Lean ingredient+food shape for the workbench worklist: products (so the inline
// editor can create/update) WITHOUT the per-usage recipe bodies that
// `ingredientWithFoodOut` carries. Those (full Recipe + Section jsonb per usage)
// are a ~24 MB payload over ~1.4k ingredients; the row only needs a usage count
// and the cookbook-only flag, and the expanded footer loads usages on demand.
const ingredientWithFoodLeanOut = ingredientOut.extend({
  product: z.array(productWithMappingsAndFoodOut),
});

/**
 * A workbench row: the lean ingredient (products + food, so the inline editor
 * can create/update directly) decorated with its recipe-usage count, the
 * cookbook-only flag, conversion coverage, the recommended next fix, a
 * price-entry mode, and merge candidates.
 */
export const enrichmentRowOut = ingredientWithFoodLeanOut.extend({
  recipeCount: z.number(),
  // Every live recipe using this ingredient is book-sourced (the imported-cookbook
  // tail the workbench can hide). Computed in SQL — was derived client-side from
  // the now-omitted `appearsInRecipes`.
  cookbookOnly: z.boolean(),
  coverage: z.object({
    covered: z.array(baseKind),
    // Kinds graded against (all four minus the ingredient's N/A opt-outs), so the
    // UI can render an N/A kind as "—" rather than a missing gap.
    applicable: z.array(baseKind),
    tier: z.enum(["complete", "good", "partial", "none"]),
  }),
  recommendedFix: enrichmentFixKind,
  priceMode: z.enum(["per-each", "package"]),
  mergeCandidates: z.array(
    z.object({
      id: ingredientId,
      name: z.string(),
      // pg_trgm similarity (0–1) to this row — suggestion-only, confirm before merging.
      similarity: z.number(),
    }),
  ),
});

export type EnrichmentRow = z.infer<typeof enrichmentRowOut>;

export class IngredientService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async enrichProductsWithFood(
    products: ProductWithMappingsOut[],
  ): Promise<ProductWithMappingsAndFoodOut[]> {
    return batchEnrichWithFood(
      products,
      foodLookupParamFromProduct,
      this.usdaClient,
    );
  }

  async getIngredientByID(id: IngredientId): Promise<IngredientWithFoodOut> {
    const ingredient = await getIngredientByIDRepo(this.db, id);
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  /**
   * Batched `getIngredientByID`: one DB query for all ids + one cross-ingredient
   * USDA enrichment pass (via batchEnrichNestedItems), instead of N×(query+enrich).
   * Used by the recipe list to compute the cost/calorie columns in one round-trip.
   */
  async getIngredientsByIDs(
    ids: IngredientId[],
  ): Promise<IngredientWithFoodOut[]> {
    return withTrace(
      TraceNames.service("ingredient", "getIngredientsByIDs"),
      async (span) => {
        span.setAttribute("ingredient.requested_count", ids.length);
        const ingredients = await getIngredientsByIDsRepo(this.db, ids);
        return batchEnrichNestedItems(
          ingredients,
          (ing) => ing.product,
          (products) => this.enrichProductsWithFood(products),
          (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts }),
        );
      },
    );
  }

  async getIngredientByName(
    name: string,
  ): Promise<IngredientWithFoodOut | null> {
    const ingredient = await getIngredientByNameRepo(this.db, name);
    if (!ingredient) return null;

    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  async ingredientList(
    nameFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    missingProductsOnly?: boolean,
  ) {
    const { data: ingredients, count } = await ingredientListRepo(
      this.db,
      nameFilter,
      sort,
      pagination,
      missingProductsOnly,
    );

    // Batch enrich products within all ingredients
    const ingredientsWithFood = await batchEnrichNestedItems(
      ingredients,
      (ing) => ing.product,
      (products) => this.enrichProductsWithFood(products),
      (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts }),
    );

    return { data: ingredientsWithFood, count };
  }

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
  async enrichmentWorkbench(): Promise<EnrichmentRow[]> {
    // Lean fetch: recipe-used ingredients + products + recipeCount/cookbookOnly
    // scalars (no per-usage recipe bodies). The footer loads usages on demand.
    const candidates = await enrichmentWorkbenchIngredientsRepo(this.db);

    const enriched = await batchEnrichNestedItems(
      candidates,
      (ing) => ing.product,
      (products) => this.enrichProductsWithFood(products),
      (ing, enrichedProducts) => ({ ...ing, product: enrichedProducts }),
    );

    const rows = enriched.map((ing): EnrichmentRow => {
      // Grade against the kinds that apply to this ingredient — the user's N/A
      // opt-outs (naKinds) drop out, so a count-only item isn't pegged below
      // "complete" for a volume it's never measured by.
      const applicable = gradedKinds(ing.naKinds);
      const coverage = conversionCoverage(
        getIngredientMappings(ing),
        applicable,
      );
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
        mergeCandidates: [] as EnrichmentRow["mergeCandidates"],
      };
    });

    // Trigram near-duplicate hints (one self-join query; we look up only the
    // rows we show). Suggestion-only — the UI confirms before merging.
    const worklist = rows.filter((r) => r.recommendedFix !== "done");
    const fuzzy = await findFuzzyMergeCandidates(this.db);
    return worklist.map((r) => ({
      ...r,
      mergeCandidates: fuzzy.get(r.id) ?? [],
    }));
  }

  async createIngredient(
    data: z.infer<typeof ingredientBase>,
    actor: ActorContext,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await createIngredientRepo(this.db, data, actor);
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  async updateIngredient(
    id: IngredientId,
    data: Partial<z.infer<typeof ingredientBase>>,
    actor: ActorContext,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await updateIngredientRepo(this.db, id, data, actor);
    // Dependent recipes are recomputed eagerly at the router layer (covers UI +
    // MCP) — see the ingredient router's update proc.
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  /**
   * Merge `aliases` into `target` (repoints recipe rows + soft-deletes aliases).
   * Post-merge the repointed rows reference the target, so the router's eager
   * recompute of the *target*'s recipes covers every recipe that used an alias.
   * This is why merge lives in the service, not as a direct repo call.
   */
  async mergeIngredients(
    target: IngredientId,
    aliases: IngredientId[],
  ): Promise<IngredientWithFoodOut> {
    await mergeIngredientsRepo(this.db, target, aliases);
    return this.getIngredientByID(target);
  }
}

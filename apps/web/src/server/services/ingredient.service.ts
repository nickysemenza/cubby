import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type {
  EnrichmentRow,
  IngredientWithFoodLeanOut,
  IngredientWithFoodOut,
  ingredientCreateInput,
  ingredientUpdateData,
} from "@cubby/schemas/ingredient";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ProductWithMappingsOut as ProductWithMappings,
  ProductWithMappingsAndFoodOut,
} from "@cubby/schemas/product";
import type { z } from "zod";
import { conversionCoverage, gradedKinds } from "~/lib/conversion-coverage";
import { classifyIngredientFix } from "~/lib/recipe-totals-gaps";
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
  getIngredientsByIDsLean as getIngredientsByIDsLeanRepo,
  ingredientList as ingredientListRepo,
  type MergeSummary,
  mergeIngredients as mergeIngredientsRepo,
  updateIngredient as updateIngredientRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
import { TraceNames, withTrace } from "../tracing";
import { batchEnrichNestedItems, batchEnrichWithFood } from "./usda-helpers";

export class IngredientService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async enrichProductsWithFood(
    products: ProductWithMappings[],
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
   * Used by the recipe-costing path (recompute / getManyByIDs) + the unit-mapping
   * analysis — all of which only read products/food, so this is the LEAN fetch: no
   * recipe-usage relation (the per-usage Recipe + Section jsonb bodies that the
   * full ingredient graph carries — a needless over-fetch for costing).
   */
  async getIngredientsByIDs(
    ids: IngredientId[],
  ): Promise<IngredientWithFoodLeanOut[]> {
    return withTrace(
      TraceNames.service("ingredient", "getIngredientsByIDs"),
      async (span) => {
        span.setAttribute("ingredient.requested_count", ids.length);
        const ingredients = await getIngredientsByIDsLeanRepo(this.db, ids);
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

    return { data: ingredients, count };
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
    data: z.input<typeof ingredientCreateInput>,
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
    data: z.infer<typeof ingredientUpdateData>,
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
   * Merge `aliases` into `target` (repoints recipe rows + hard-deletes aliases).
   * Returns the surviving ingredient plus a structured change summary. The
   * absorbed recipes are marked stale in-transaction; the caller dispatches the
   * recompute off the request path (a widely-used target can touch 100+ recipes,
   * which overruns the Workers CPU budget if recomputed inline). `dryRun`
   * validates + counts what would change without writing.
   */
  async mergeIngredients(
    target: IngredientId,
    aliases: IngredientId[],
    opts?: { dryRun?: boolean },
  ): Promise<{ ingredient: IngredientWithFoodOut; summary: MergeSummary }> {
    const summary = await mergeIngredientsRepo(this.db, target, aliases, opts);
    const ingredient = await this.getIngredientByID(target);
    return { ingredient, summary };
  }
}

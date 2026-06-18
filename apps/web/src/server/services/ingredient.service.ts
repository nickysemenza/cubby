import {
  ingredientWithRecipesAndProductOut,
  type ProductWithMappingsOut,
} from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId } from "@cubby/schemas/identifiers";
import type { ingredientBase } from "@cubby/schemas/ingredient";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { productTopLevelOut } from "@cubby/schemas/product";
import { unitMappingOut } from "@cubby/schemas/unitmapping";
import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
// Extended schemas that include food data
import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import {
  createIngredient as createIngredientRepo,
  getIngredientByID as getIngredientByIDRepo,
  getIngredientByName as getIngredientByNameRepo,
  getIngredientsByIDs as getIngredientsByIDsRepo,
  ingredientList as ingredientListRepo,
  mergeIngredients as mergeIngredientsRepo,
  updateIngredient as updateIngredientRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
import { markRecipesStaleForIngredient } from "../repo/recipe/totals";
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
    // An ingredient edit can change its contribution to recipe totals; stale the
    // recipes that use it so the drain recomputes (over-invalidates benignly).
    await markRecipesStaleForIngredient(this.db, id);
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  /**
   * Merge `aliases` into `target` (repoints recipe rows + soft-deletes aliases),
   * then stale the target's recipes — post-merge the repointed rows reference the
   * target, so invalidating it covers every recipe that used a merged alias.
   * This is why merge lives in the service, not as a direct repo call.
   */
  async mergeIngredients(
    target: IngredientId,
    aliases: IngredientId[],
  ): Promise<IngredientWithFoodOut> {
    await mergeIngredientsRepo(this.db, target, aliases);
    await markRecipesStaleForIngredient(this.db, target);
    return this.getIngredientByID(target);
  }
}

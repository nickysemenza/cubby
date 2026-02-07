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
  ingredientList as ingredientListRepo,
  updateIngredient as updateIngredientRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
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
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }
}

import { type PrismaClient } from "@prisma/client";
import { USDAClient } from "../clients/usda";
import {
  getIngredientByID as getIngredientByIDRepo,
  getIngredientByName as getIngredientByNameRepo,
  ingredientList as ingredientListRepo,
  createIngredient as createIngredientRepo,
  updateIngredient as updateIngredientRepo,
  mergeIngredients as mergeIngredientsRepo,
} from "../repo/ingredient";
import { foodLookupParamFromProduct } from "../repo/product";
import { ingredientBase } from "~/schemas/ingredient";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";
import {
  ingredientWithRecipesAndProductOut,
  type ProductWithMappingsOut,
} from "~/schemas/combo";
import { foodSummary } from "@recipehub/usda-schemas";
import { z } from "zod";

// Extended schemas that include food data
import { productTopLevelOut } from "~/schemas/product";
import { unitMappingOut } from "~/schemas/unitmapping";

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
    private db: PrismaClient,
    private usdaClient: USDAClient,
  ) {}

  async enrichProductsWithFood(
    products: ProductWithMappingsOut[],
  ): Promise<ProductWithMappingsAndFoodOut[]> {
    return Promise.all(
      products.map(async (product) => {
        const lookupParam = foodLookupParamFromProduct(product);
        const food = lookupParam
          ? await this.usdaClient.findFood(lookupParam)
          : null;
        return {
          ...product,
          food,
        };
      }),
    );
  }

  async getIngredientByID(id: string): Promise<IngredientWithFoodOut> {
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

    // Enrich each ingredient's products with food data
    const ingredientsWithFood = await Promise.all(
      ingredients.map(async (ingredient) => {
        const enrichedProducts = await this.enrichProductsWithFood(
          ingredient.product,
        );
        return {
          ...ingredient,
          product: enrichedProducts,
        };
      }),
    );

    return { data: ingredientsWithFood, count };
  }

  async createIngredient(
    data: z.infer<typeof ingredientBase>,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await createIngredientRepo(this.db, data);
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  async updateIngredient(
    id: string,
    data: Partial<z.infer<typeof ingredientBase>>,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await updateIngredientRepo(this.db, id, data);
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  async mergeIngredients(target: string, aliases: string[]): Promise<void> {
    return mergeIngredientsRepo(this.db, target, aliases);
  }
}

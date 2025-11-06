import { type Database } from "~/server/db";
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
import { type IngredientId, type OrganizationId } from "~/schemas/identifiers";

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
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async enrichProductsWithFood(
    products: ProductWithMappingsOut[],
  ): Promise<ProductWithMappingsAndFoodOut[]> {
    if (products.length === 0) return [];

    // Collect all lookup parameters
    const lookupParams = products.map((product) =>
      foodLookupParamFromProduct(product),
    );
    const validLookups = lookupParams.filter(
      (param): param is NonNullable<typeof param> => param !== null,
    );

    // Batch fetch food data
    const foodResults =
      validLookups.length > 0
        ? await this.usdaClient.findFoodsBatch(validLookups)
        : [];

    // Map foods back to products
    let foodIndex = 0;
    return products.map((product) => {
      const lookupParam = foodLookupParamFromProduct(product);
      const food = lookupParam ? foodResults[foodIndex++] : null;
      return {
        ...product,
        food,
      };
    });
  }

  async getIngredientByID(
    id: IngredientId,
    organizationId: OrganizationId,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await getIngredientByIDRepo(this.db, id, organizationId);
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
    organizationId: OrganizationId,
    nameFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    missingProductsOnly?: boolean,
  ) {
    const { data: ingredients, count } = await ingredientListRepo(
      this.db,
      organizationId,
      nameFilter,
      sort,
      pagination,
      missingProductsOnly,
    );

    // Collect all products from all ingredients for batch processing
    const allProducts: ProductWithMappingsOut[] = [];
    const ingredientProductCounts: number[] = [];

    ingredients.forEach((ingredient) => {
      ingredientProductCounts.push(ingredient.product.length);
      allProducts.push(...ingredient.product);
    });

    // Batch enrich all products at once
    const allEnrichedProducts = await this.enrichProductsWithFood(allProducts);

    // Map enriched products back to their ingredients
    let productIndex = 0;
    const ingredientsWithFood = ingredients.map(
      (ingredient, ingredientIndex) => {
        const productCount = ingredientProductCounts[ingredientIndex] || 0;
        const enrichedProducts = allEnrichedProducts.slice(
          productIndex,
          productIndex + productCount,
        );
        productIndex += productCount;

        return {
          ...ingredient,
          product: enrichedProducts,
        };
      },
    );

    return { data: ingredientsWithFood, count };
  }

  async createIngredient(
    data: z.infer<typeof ingredientBase>,
    organizationId: OrganizationId,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await createIngredientRepo(
      this.db,
      data,
      organizationId,
    );
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
    organizationId: OrganizationId,
    data: Partial<z.infer<typeof ingredientBase>>,
  ): Promise<IngredientWithFoodOut> {
    const ingredient = await updateIngredientRepo(
      this.db,
      id,
      organizationId,
      data,
    );
    const enrichedProducts = await this.enrichProductsWithFood(
      ingredient.product,
    );

    return {
      ...ingredient,
      product: enrichedProducts,
    };
  }

  async mergeIngredients(
    target: IngredientId,
    aliases: IngredientId[],
  ): Promise<void> {
    return mergeIngredientsRepo(this.db, target, aliases);
  }
}

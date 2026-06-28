import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ProductCategory,
  ProductCreateInput,
  ProductSummariesInput,
  ProductSummariesOut,
  ProductUpdateInput,
  ProductWithFoodOut,
} from "@cubby/schemas/product";
import type { FoodSummary } from "@cubby/usda-schemas";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import { getRecipeUsagesForIngredient } from "../repo/ingredient";
import {
  createProduct as createProductRepo,
  foodLookupParamFromProduct,
  getProductByID as getProductByIDRepo,
  getProductImagesByProductIds,
  getProductsForFoodLookup,
  getProductUnitMappingsByProductIds,
  productList as productListRepo,
  updateProduct as updateProductRepo,
} from "../repo/product";
import { batchEnrichWithFood } from "./usda-helpers";

export interface ProductService {
  getProductByID(id: ProductId): Promise<ProductWithFoodOut>;
  productList(
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    categoryFilter: ProductCategory | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    groupBy?: string,
  ): ReturnType<typeof productListRepo>;
  getSummariesByProductIds(
    ids: ProductId[],
    include: ProductSummariesInput["include"],
  ): Promise<ProductSummariesOut>;
  createProduct(
    data: ProductCreateInput,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut>;
  updateProduct(
    id: ProductId,
    data: ProductUpdateInput["data"],
    actor: ActorContext,
  ): Promise<ProductWithFoodOut>;
}

const getProductWithFood = async (
  db: Database,
  usdaClient: USDAClient,
  id: ProductId,
): Promise<ProductWithFoodOut> => {
  const product = await getProductByIDRepo(db, id);

  // Resolve the linked food: explicit fdc_id wins, else UPC auto-match.
  const lookupParam = foodLookupParamFromProduct(product);
  const food = lookupParam ? await usdaClient.findFood(lookupParam) : null;

  // Recipes the product appears in, resolved through its linked ingredient.
  const { recipeUsages } = product.ingredient
    ? await getRecipeUsagesForIngredient(db, product.ingredient.id)
    : { recipeUsages: [] };

  return {
    ...product,
    food,
    recipeUsages,
  };
};

const getProductFoodSummaries = async (
  db: Database,
  usdaClient: USDAClient,
  ids: ProductId[],
): Promise<Record<string, FoodSummary | null>> => {
  const uniqueIds = uniq(ids);
  const result: Record<string, FoodSummary | null> = Object.fromEntries(
    uniqueIds.map((id) => [id, null]),
  );
  if (uniqueIds.length === 0) return result;

  const products = await getProductsForFoodLookup(db, uniqueIds);
  const productsWithFood = await batchEnrichWithFood(
    products,
    foodLookupParamFromProduct,
    usdaClient,
  );

  for (const product of productsWithFood) {
    result[product.id] = product.food;
  }

  return result;
};

const getProductSummaries = async (
  db: Database,
  usdaClient: USDAClient,
  ids: ProductId[],
  include: ProductSummariesInput["include"],
): Promise<ProductSummariesOut> => {
  const requested = new Set(include);
  const summaries: ProductSummariesOut = {};

  await Promise.all([
    requested.has("food")
      ? getProductFoodSummaries(db, usdaClient, ids).then((food) => {
          summaries.food = food;
        })
      : undefined,
    requested.has("images")
      ? getProductImagesByProductIds(db, ids).then((images) => {
          summaries.images = images;
        })
      : undefined,
    requested.has("unitMappings")
      ? getProductUnitMappingsByProductIds(db, ids).then((unitMappings) => {
          summaries.unitMappings = unitMappings;
        })
      : undefined,
  ]);

  return summaries;
};

export const createProductService = (
  db: Database,
  usdaClient: USDAClient,
): ProductService => ({
  getProductByID: (id) => getProductWithFood(db, usdaClient, id),
  productList: (
    nameFilter,
    manufacturerFilter,
    upcFilter,
    categoryFilter,
    sort,
    pagination,
    groupBy,
  ) =>
    productListRepo(
      db,
      nameFilter,
      manufacturerFilter,
      upcFilter,
      categoryFilter,
      sort,
      pagination,
      groupBy,
    ),
  getSummariesByProductIds: (ids, include) =>
    getProductSummaries(db, usdaClient, ids, include),
  createProduct: async (data, actor) => {
    const product = await createProductRepo(db, data, actor);
    // Dependent recipes are recomputed eagerly at the router (the single `create`
    // proc per product, `createMany` once over the deduped union) — covers UI +
    // MCP. No mark-stale; there is no drain anymore.
    return await getProductWithFood(db, usdaClient, product.id);
  },
  updateProduct: async (id, data, actor) => {
    await updateProductRepo(db, id, data, actor);
    // Eager recompute of dependent recipes (and inventory valuations) happens at
    // the router layer (covers UI + MCP callers) — see the product router's
    // update proc.
    return await getProductWithFood(db, usdaClient, id);
  },
});

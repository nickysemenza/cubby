import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { ImageOut } from "@cubby/schemas/image";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ProductCategory,
  ProductCreateInput,
  ProductUpdateInput,
} from "@cubby/schemas/product";
import type { ProductWithFoodOut } from "@cubby/schemas/product-responses";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import type { FoodSummary } from "@cubby/usda-schemas";
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

export class ProductService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async getProductByID(id: ProductId): Promise<ProductWithFoodOut> {
    const product = await getProductByIDRepo(this.db, id);

    // Resolve the linked food: explicit fdc_id wins, else UPC auto-match.
    const lookupParam = foodLookupParamFromProduct(product);
    const food = lookupParam
      ? await this.usdaClient.findFood(lookupParam)
      : null;

    // Recipes the product appears in, resolved through its linked ingredient.
    const { recipeUsages } = product.ingredient
      ? await getRecipeUsagesForIngredient(this.db, product.ingredient.id)
      : { recipeUsages: [] };

    return {
      ...product,
      food,
      recipeUsages,
    };
  }

  async productList(
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    categoryFilter: ProductCategory | undefined,
    sort: SortParams,
    pagination: PaginationParams,
    groupBy?: string,
  ) {
    const { data: products, count } = await productListRepo(
      this.db,
      nameFilter,
      manufacturerFilter,
      upcFilter,
      categoryFilter,
      sort,
      pagination,
      groupBy,
    );

    return { data: products, count };
  }

  async getFoodSummariesByProductIds(
    ids: ProductId[],
  ): Promise<Record<string, FoodSummary | null>> {
    const uniqueIds = [...new Set(ids)];
    const result: Record<string, FoodSummary | null> = Object.fromEntries(
      uniqueIds.map((id) => [id, null]),
    );
    if (uniqueIds.length === 0) return result;

    const products = await getProductsForFoodLookup(this.db, uniqueIds);
    const productsWithFood = await batchEnrichWithFood(
      products,
      foodLookupParamFromProduct,
      this.usdaClient,
    );

    for (const product of productsWithFood) {
      result[product.id] = product.food;
    }

    return result;
  }

  async getImageSummariesByProductIds(
    ids: ProductId[],
  ): Promise<Record<string, ImageOut[]>> {
    return await getProductImagesByProductIds(this.db, ids);
  }

  async getUnitMappingSummariesByProductIds(
    ids: ProductId[],
  ): Promise<Record<string, UnitMapping[]>> {
    return await getProductUnitMappingsByProductIds(this.db, ids);
  }

  async createProduct(
    data: ProductCreateInput,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    const product = await createProductRepo(this.db, data, actor);
    // Dependent recipes are recomputed eagerly at the router (the single `create`
    // proc per product, `createMany` once over the deduped union) — covers UI +
    // MCP. No mark-stale; there is no drain anymore.
    return await this.getProductByID(product.id);
  }

  async updateProduct(
    id: ProductId,
    data: ProductUpdateInput["data"],
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data, actor);
    // Eager recompute of dependent recipes (and inventory valuations) happens at
    // the router layer (covers UI + MCP callers) — see the product router's
    // update proc.
    return await this.getProductByID(id);
  }
}

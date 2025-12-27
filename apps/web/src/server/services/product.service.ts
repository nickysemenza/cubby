import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import {
  getProductByID as getProductByIDRepo,
  productList as productListRepo,
  createProduct as createProductRepo,
  updateProduct as updateProductRepo,
  foodLookupParamFromProduct,
} from "../repo/product";
import type { ProductInputPayload, ProductCategory } from "~/schemas/product";
import type { SortParams, PaginationParams } from "~/schemas/pagination";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { foodSummary } from "@recipehub/usda-schemas";
import type { z } from "zod";
import type { ProductId, OrganizationId } from "~/schemas/identifiers";
import { batchEnrichWithFood } from "./usda-helpers";
import type { ActorContext } from "~/schemas/context";

// Extended schema that includes food data
export const productWithFoodOut =
  productWithIngredientAndInventoryAndMappingsOut.extend({
    food: foodSummary.nullable(),
  });

export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export class ProductService {
  constructor(
    private db: Database,
    private usdaClient: USDAClient,
  ) {}

  async getProductByID(
    id: ProductId,
    organizationId: OrganizationId,
  ): Promise<ProductWithFoodOut> {
    const product = await getProductByIDRepo(this.db, id, organizationId);
    const lookupParam = foodLookupParamFromProduct(product);
    const food = lookupParam
      ? await this.usdaClient.findFood(lookupParam)
      : null;

    return {
      ...product,
      food,
    };
  }

  async productList(
    organizationId: OrganizationId,
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    categoryFilter: ProductCategory | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const { data: products, count } = await productListRepo(
      this.db,
      organizationId,
      nameFilter,
      manufacturerFilter,
      upcFilter,
      categoryFilter,
      sort,
      pagination,
    );

    const productsWithFood = await batchEnrichWithFood(
      products,
      foodLookupParamFromProduct,
      this.usdaClient,
    );

    return { data: productsWithFood, count };
  }

  async createProduct(
    data: ProductInputPayload,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    const product = await createProductRepo(this.db, data, actor);
    return this.getProductByID(product.id, actor.organizationId);
  }

  async updateProduct(
    id: ProductId,
    data: Partial<ProductInputPayload>,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data, actor);
    return this.getProductByID(id, actor.organizationId);
  }
}

import { type PrismaClient } from "@prisma/client";
import { USDAClient } from "../clients/usda";
import {
  getProductByID as getProductByIDRepo,
  productList as productListRepo,
  createProduct as createProductRepo,
  updateProduct as updateProductRepo,
  foodLookupParamFromProduct,
} from "../repo/product";
import { type ProductInputPayload } from "~/schemas/product";
import { type SortParams, type PaginationParams } from "~/schemas/pagination";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import { foodSummary } from "@recipehub/usda-schemas";
import { z } from "zod";

// Extended schema that includes food data
export const productWithFoodOut =
  productWithIngredientAndInventoryAndMappingsOut.extend({
    food: foodSummary.nullable(),
  });

export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

export class ProductService {
  constructor(
    private db: PrismaClient,
    private usdaClient: USDAClient,
  ) {}

  async getProductByID(id: string): Promise<ProductWithFoodOut> {
    const product = await getProductByIDRepo(this.db, id);
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
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const { data: products, count } = await productListRepo(
      this.db,
      nameFilter,
      manufacturerFilter,
      upcFilter,
      sort,
      pagination,
    );

    // Enrich each product with food data
    const productsWithFood = await Promise.all(
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

    return { data: productsWithFood, count };
  }

  async createProduct(data: ProductInputPayload): Promise<ProductWithFoodOut> {
    const product = await createProductRepo(this.db, data);
    return this.getProductByID(product.id);
  }

  async updateProduct(
    id: string,
    data: Partial<ProductInputPayload>,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data);
    return this.getProductByID(id);
  }
}

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
import { type ProductId, type ProjectId } from "~/schemas/identifiers";

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

  async getProductByID(
    id: ProductId,
    projectId: ProjectId,
  ): Promise<ProductWithFoodOut> {
    const product = await getProductByIDRepo(this.db, id, projectId);
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
    projectId: ProjectId,
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const { data: products, count } = await productListRepo(
      this.db,
      projectId,
      nameFilter,
      manufacturerFilter,
      upcFilter,
      sort,
      pagination,
    );

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
    const productsWithFood = products.map((product) => {
      const lookupParam = foodLookupParamFromProduct(product);
      const food = lookupParam ? foodResults[foodIndex++] : null;
      return {
        ...product,
        food,
      };
    });

    return { data: productsWithFood, count };
  }

  async createProduct(
    data: ProductInputPayload,
    projectId: ProjectId,
  ): Promise<ProductWithFoodOut> {
    const product = await createProductRepo(this.db, data, projectId);
    return this.getProductByID(product.id, projectId);
  }

  async updateProduct(
    id: ProductId,
    projectId: ProjectId,
    data: Partial<ProductInputPayload>,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, projectId, data);
    return this.getProductByID(id, projectId);
  }
}

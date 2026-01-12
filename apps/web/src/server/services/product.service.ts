import { foodLookupParam, foodSummary } from "@recipehub/usda-schemas";
import type { z } from "zod";
import { productWithIngredientAndInventoryAndMappingsOut } from "~/schemas/combo";
import type { ActorContext } from "~/schemas/context";
import type { ProductId } from "~/schemas/identifiers";
import type { PaginationParams, SortParams } from "~/schemas/pagination";
import type { ProductCategory, ProductCreateInput } from "~/schemas/product";
import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import {
  createProduct as createProductRepo,
  foodLookupParamFromProduct,
  getProductByID as getProductByIDRepo,
  productList as productListRepo,
  updateProduct as updateProductRepo,
} from "../repo/product";
import { batchEnrichWithFood } from "./usda-helpers";

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

  async getProductByID(id: ProductId): Promise<ProductWithFoodOut> {
    const product = await getProductByIDRepo(this.db, id);

    // Try UPC lookup first (prioritized by foodLookupParamFromProduct)
    const lookupParam = foodLookupParamFromProduct(product);
    let food = lookupParam ? await this.usdaClient.findFood(lookupParam) : null;

    // If UPC failed and product has NDB, try NDB as fallback
    if (!food && product.upc && product.ndb_number) {
      const ndbParam = foodLookupParam.safeParse({
        kind: "ndb",
        ndb_number: product.ndb_number,
      });
      if (ndbParam.success) {
        food = await this.usdaClient.findFood(ndbParam.data);
      }
    }

    return {
      ...product,
      food,
    };
  }

  async productList(
    nameFilter: string | undefined,
    manufacturerFilter: string | undefined,
    upcFilter: string | undefined,
    categoryFilter: ProductCategory | undefined,
    sort: SortParams,
    pagination: PaginationParams,
  ) {
    const { data: products, count } = await productListRepo(
      this.db,
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
    data: ProductCreateInput,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    const product = await createProductRepo(this.db, data, actor);
    return this.getProductByID(product.id);
  }

  async updateProduct(
    id: ProductId,
    data: Partial<ProductCreateInput>,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data, actor);
    return this.getProductByID(id);
  }
}

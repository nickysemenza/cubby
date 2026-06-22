import {
  productWithIngredientAndInventoryAndMappingsOut,
  recipeUsageOut,
} from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import type { ProductId } from "@cubby/schemas/identifiers";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  ProductCategory,
  ProductCreateInput,
} from "@cubby/schemas/product";
import { foodSummary } from "@cubby/usda-schemas";
import { z } from "zod";
import type { Database } from "~/server/db";
import type { USDAClient } from "../clients/usda";
import { getRecipeUsagesForIngredient } from "../repo/ingredient";
import {
  createProduct as createProductRepo,
  foodLookupParamFromProduct,
  getProductByID as getProductByIDRepo,
  productList as productListRepo,
  updateProduct as updateProductRepo,
} from "../repo/product";
import { batchEnrichWithFood } from "./usda-helpers";

// Extended schema that includes food data plus the recipes the product's linked
// ingredient appears in. `recipeUsages` defaults to [] so the list path (which
// doesn't compute usages) stays valid against this shared output schema.
export const productWithFoodOut =
  productWithIngredientAndInventoryAndMappingsOut.extend({
    food: foodSummary.nullable(),
    recipeUsages: z.array(recipeUsageOut).default([]),
  });

export type ProductWithFoodOut = z.infer<typeof productWithFoodOut>;

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

    const productsWithFood = await batchEnrichWithFood(
      products,
      foodLookupParamFromProduct,
      this.usdaClient,
    );

    // The list doesn't compute recipe usages (detail-only); satisfy the shared
    // `productWithFoodOut` shape with an empty array per row.
    const data = productsWithFood.map((p) => ({ ...p, recipeUsages: [] }));

    return { data, count };
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
    data: Partial<ProductCreateInput>,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data, actor);
    // Eager recompute of dependent recipes (and inventory valuations) happens at
    // the router layer (covers UI + MCP callers) — see the product router's
    // update proc.
    return await this.getProductByID(id);
  }
}

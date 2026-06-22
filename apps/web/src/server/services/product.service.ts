import {
  productWithIngredientAndInventoryAndMappingsOut,
  recipeUsageOut,
} from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import type { IngredientId, ProductId } from "@cubby/schemas/identifiers";
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
import { markRecipesStaleForIngredient } from "../repo/recipe/totals";
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
    const result = await this.getProductByID(product.id);
    await this.invalidateRecipeTotals(result.ingredient?.id);
    return result;
  }

  async updateProduct(
    id: ProductId,
    data: Partial<ProductCreateInput>,
    actor: ActorContext,
  ): Promise<ProductWithFoodOut> {
    await updateProductRepo(this.db, id, data, actor);
    const result = await this.getProductByID(id);
    await this.invalidateRecipeTotals(result.ingredient?.id);
    return result;
  }

  /**
   * A product's price/USDA link feeds recipe cost & calories via its linked
   * ingredient. Null the persisted totals of every recipe using that ingredient
   * so the drain recomputes them. Over-invalidates on benign edits (no diffing),
   * which is fine — recompute is cheap and deferred.
   */
  private async invalidateRecipeTotals(
    ingredientId: IngredientId | undefined,
  ): Promise<void> {
    if (!ingredientId) return;
    await markRecipesStaleForIngredient(this.db, ingredientId);
  }
}

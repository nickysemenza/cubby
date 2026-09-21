import type { ProductListItem } from "@cubby/schemas/product";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import {
  batchEnrichWithFood,
  type UsdaFoodBatchPort,
} from "~/server/services/usda-helpers";

/**
 * Adds the USDA projection and every derived unit price to one product-list
 * snapshot. Both top-level rows and nested kit rows use this projection so
 * their displayed values and explanation sources cannot diverge.
 */
export async function enrichProductListItems(
  products: ProductListItem[],
  usdaClient?: UsdaFoodBatchPort,
): Promise<ProductListItem[]> {
  const foodEnriched = usdaClient
    ? await batchEnrichWithFood(
        products,
        foodLookupParamFromProduct,
        usdaClient,
      )
    : products.map((product) => ({ ...product, food: null }));

  return foodEnriched.map(({ food, ...product }) => {
    const unitPriceMappings = getAllUnitMappingsFromProduct({
      ...product,
      food,
    });
    return {
      ...product,
      food,
      unitPriceMappings,
      unitPrice: computePerUnitPrices(unitPriceMappings),
    };
  });
}

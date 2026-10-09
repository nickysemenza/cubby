import type { ProductListItem } from "@cubby/schemas/product";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { foodLookupParamFromProduct } from "~/server/repo/product/helpers";
import {
  batchEnrichWithFood,
  type UsdaFoodBatchPort,
} from "~/server/services/usda-helpers";

type ProductListEnrichmentInput = Pick<
  ProductListItem,
  | "id"
  | "primaryGtin"
  | "fdc_id"
  | "unitMappings"
  | "labelNutrition"
  | "price"
  | "pricing"
>;

/**
 * Starts the USDA batch for these products without awaiting it, as soon as
 * their lookup keys (barcode, `fdc_id`) are read. `USDAClient.findFoodsBatch`
 * memoizes each key's in-flight lookup for the request, so the later
 * `enrichProductListItems` call joins this one and the external hop overlaps
 * the local enrichment reads. A failure surfaces from that later call.
 */
export function prefetchProductFoods(
  products: Parameters<typeof foodLookupParamFromProduct>[0][],
  usdaClient?: UsdaFoodBatchPort,
): void {
  const lookups = products.flatMap(
    (product) => foodLookupParamFromProduct(product) ?? [],
  );
  if (usdaClient && lookups.length > 0)
    usdaClient.findFoodsBatch(lookups).catch(() => {
      // SILENT: the memoized batch rejects again for enrichProductListItems,
      // which surfaces it; this handle only prevents an unhandled rejection.
    });
}

/**
 * Adds the USDA projection and every derived unit price to one product-list
 * snapshot. Both top-level rows and nested kit rows use this projection so
 * their displayed values and explanation sources cannot diverge.
 */
export async function enrichProductListItems<
  T extends ProductListEnrichmentInput,
>(products: T[], usdaClient?: UsdaFoodBatchPort) {
  const foodEnriched = usdaClient
    ? await batchEnrichWithFood(
        products,
        foodLookupParamFromProduct,
        usdaClient,
      )
    : products.map((product) => ({ ...product, food: null }));

  return foodEnriched.map((product) => {
    const unitPriceMappings = getAllUnitMappingsFromProduct(product);
    return {
      ...product,
      unitPriceMappings,
      unitPrice: computePerUnitPrices(unitPriceMappings),
    };
  });
}

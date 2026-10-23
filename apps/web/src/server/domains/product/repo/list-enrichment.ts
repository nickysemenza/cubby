import type { ProductListItem } from "@cubby/schemas/product";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { unitPriceLabel } from "~/server/generic/list/repo/list-display-labels";

/** The same conversion graph backs detail values and compact list prices. */
export const productUnitPriceDetailLabel = (
  product: Parameters<typeof getAllUnitMappingsFromProduct>[0] &
    Pick<ProductListItem, "category">,
): string | null =>
  isServiceProductCategory(product.category)
    ? "Not applicable—charges may cover different periods, usage, or seats. See Average charge."
    : unitPriceLabel(
        computePerUnitPrices(getAllUnitMappingsFromProduct(product)),
      );
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import {
  batchEnrichWithFood,
  type UsdaFoodBatchPort,
} from "~/server/domains/usda-food/repo/usda-helpers";

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

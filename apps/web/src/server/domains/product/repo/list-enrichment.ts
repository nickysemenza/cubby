import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import { rawProductList } from "@cubby/schemas/product-raw-read";
import type {
  RawProductList,
  RawProductDetail,
} from "@cubby/schemas/product-raw-read";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { unitPriceLabel } from "~/server/generic/list/repo/list-display-labels";

// Nested categories are already public here; applicability comes from the selected price decision.
const unitPriceReadInput = rawProductList.pick({
  id: true,
  unitMappings: true,
  food: true,
  labelNutrition: true,
});

type ProductUnitPriceProjection = Pick<
  RawProductDetail,
  "unitPriceMappings"
> & {
  service: boolean;
  values: Pick<RawProductList, "unitPrice" | "unitPriceLabel"> & {
    unitPriceDetailLabel: Exclude<
      RawProductDetail["unitPriceDetailLabel"],
      undefined
    >;
  };
};

/** Public quotes use the selected valuation; private aggregates remain calculation evidence. */
export function projectProductUnitPrices({
  product,
  price,
  service,
}: {
  product: unknown;
  price: number | null;
  service: boolean;
}): ProductUnitPriceProjection {
  const input = unitPriceReadInput.parse(product);
  const unitPriceMappings = getAllUnitMappingsFromProduct({ ...input, price });
  const comparable = computePerUnitPrices(unitPriceMappings);
  const unitPrice =
    service || (comparable.natural === null && comparable.perGram === null)
      ? null
      : comparable;
  const label = unitPriceLabel(unitPrice);
  return {
    unitPriceMappings,
    service,
    values: {
      unitPrice,
      unitPriceLabel: label,
      unitPriceDetailLabel: service
        ? "Not applicable—charges may cover different periods, usage, or seats. See Cost."
        : label,
    },
  };
}

/** Detail labels and explanation evidence come from the same conversion graph. */
export const productUnitPriceDetailFields = (
  product: Parameters<typeof getAllUnitMappingsFromProduct>[0] &
    Pick<RawProductList, "category" | "pricing">,
): Pick<RawProductDetail, "unitPriceMappings" | "unitPriceDetailLabel"> => {
  const unitPriceMappings = getAllUnitMappingsFromProduct({
    ...product,
    price: product.pricing.effectivePrice,
  });
  return {
    unitPriceMappings,
    unitPriceDetailLabel: isServiceProductCategory(product.category)
      ? "Not applicable—charges may cover different periods, usage, or seats. See Cost."
      : unitPriceLabel(computePerUnitPrices(unitPriceMappings)),
  };
};
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import {
  batchEnrichWithFood,
  type UsdaFoodBatchPort,
} from "~/server/domains/usda-food/repo/usda-helpers";

type ProductListEnrichmentInput = Pick<
  RawProductList,
  | "id"
  | "primaryGtin"
  | "fdc_id"
  | "unitMappings"
  | "labelNutrition"
  | "price"
  | "pricing"
>;

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
    const unitPriceMappings = getAllUnitMappingsFromProduct({
      ...product,
      price: product.pricing.effectivePrice,
    });
    return {
      ...product,
      unitPriceMappings,
      unitPrice: computePerUnitPrices(unitPriceMappings),
    };
  });
}

/**
 * Re-applies USDA food and the unit prices that depend on it to rows read
 * through `productScaffold` without a reader client (kit component rows).
 */
export async function overlayProductFood<
  T extends ProductListEnrichmentInput & { unitPriceLabel?: string | null },
>(rows: T[], usdaClient?: UsdaFoodBatchPort): Promise<T[]> {
  if (!usdaClient || rows.length === 0) return rows;
  const enriched = await enrichProductListItems(rows, usdaClient);
  return enriched.map((row) => ({
    ...row,
    unitPriceLabel: unitPriceLabel(row.unitPrice),
  }));
}

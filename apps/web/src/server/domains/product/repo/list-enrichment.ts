import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import { rawProductList } from "@cubby/schemas/product-raw-read";
import type {
  RawProductList,
  RawProductDetail,
} from "@cubby/schemas/product-raw-read";

import { computePerUnitPrices } from "~/lib/price-mapping-utils";
import {
  getAllUnitMappingsFromProduct,
  getProductDisplays,
} from "~/lib/unit-mapping-utils";
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
  const [projection] = projectProductUnitPriceBatch([
    { product, price, service },
  ]);
  if (!projection) throw new Error("Product display batch omitted its input");
  return projection;
}

export function projectProductUnitPriceBatch(
  requests: readonly Parameters<typeof projectProductUnitPrices>[0][],
): ProductUnitPriceProjection[] {
  const displays = getProductDisplays(
    requests.map(({ product, price }) => ({
      ...unitPriceReadInput.parse(product),
      price,
    })),
  );
  return requests.map(({ service }, index) => {
    const display = displays[index];
    if (!display) throw new Error("Product display batch omitted its input");
    const { unitPriceMappings, unitPrice: comparable } = display;
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
  });
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

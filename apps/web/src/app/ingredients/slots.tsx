import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import { FullNutrientBreakdown } from "~/app/_components/nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "~/app/_components/nutrition/NutrientDensityStats";
import { ProductNutritionLabel } from "~/app/_components/nutrition/ProductNutritionLabel";
import { Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { labelNutrientsPer100 } from "~/lib/label-nutrition";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";

/**
 * Nutrition and cost-per-nutrient must share one product's basis — pricing
 * one product's protein off a different product's nutrients would silently
 * misattribute cost. Pick the product carrying both (falling back to
 * nutrition alone when none has a price). A `labelNutrition` override is
 * preferred over USDA nutrition — the same precedence as `productWasmInputs`'
 * costing — before falling back to price.
 */
export function selectNutritionProduct(
  products: ProductWithMappingsAndFoodOut[],
): ProductWithMappingsAndFoodOut | undefined {
  return (
    products.find((p) => p.labelNutrition != null && p.price != null) ??
    products.find((p) => p.labelNutrition != null) ??
    products.find((p) => p.food?.nutritionInfo && p.price != null) ??
    products.find((p) => p.food?.nutritionInfo)
  );
}

/** The ingredient's nutrition, shown from the one product that supplies it. */
export const IngredientNutritionProduct: DetailSlotComponent<"ingredient"> = ({
  record: ingredient,
}) => {
  const product = selectNutritionProduct(ingredient.product);
  const nutrients = product?.labelNutrition
    ? labelNutrientsPer100(product.labelNutrition)
    : product?.food?.nutritionInfo?.nutrientsPer100;
  if (!product || !nutrients)
    return (
      <Description>
        No nutrition on file — none of this ingredient&apos;s products carries a
        USDA food or a package label.
      </Description>
    );
  const mappings = getAllUnitMappingsFromProduct(product);
  return (
    <Stack gap="md">
      <ProductNutritionLabel
        nutrients={nutrients}
        mappings={mappings}
        portions={product.food?.portionInfoRaw ?? []}
        servingGrams={product.labelNutrition?.servingGrams}
      />
      <Description>
        {product.labelNutrition
          ? "From package label, shown from "
          : "Shown from "}
        {product.name}
        {product.manufacturer ? ` by ${product.manufacturer}` : ""}.
      </Description>
      <NutrientDensityStats
        nutrients={nutrients}
        mappings={mappings}
        price={product.pricing.effectivePrice ?? product.price}
        mappingProduct={{
          id: product.id,
          name: product.name,
          manufacturer: product.manufacturer,
        }}
      />
      {/* USDA-only: the full raw nutrient join behind a disclosure. A label
          override has no such join, and when both exist the label leads. */}
      {!product.labelNutrition && product.food?.nutritionInfo && (
        <FullNutrientBreakdown nutritionInfo={product.food.nutritionInfo} />
      )}
    </Stack>
  );
};

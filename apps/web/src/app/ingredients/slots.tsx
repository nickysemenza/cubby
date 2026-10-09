import type { DetailSlotComponent } from "~/entity/entity-detail/detail-hooks";
import { FullNutrientBreakdown } from "~/features/nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "~/features/nutrition/NutrientDensityStats";
import { ProductNutritionLabel } from "~/features/nutrition/ProductNutritionLabel";
import { RecipeUsagesTable } from "~/features/recipes/recipe-usages-table";
import { useReparseUsage } from "~/features/recipes/use-reparse-usage";
import { labelNutrientsPer100 } from "~/lib/label-nutrition";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";

/**
 * The ingredient's nutrition, shown from the one product the server chose
 * (`nutritionProduct`, shared with native).
 */
export const IngredientNutritionProduct: DetailSlotComponent<"ingredient"> = ({
  record: ingredient,
}) => {
  const product = ingredient.product.find(
    (candidate) => candidate.id === ingredient.nutritionProduct?.productId,
  );
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

/**
 * Every recipe line using this ingredient, with parser drift. A drifted line
 * offers "Re-parse", which applies the fresh parse to that line.
 */
export const IngredientRecipeUsages: DetailSlotComponent<"ingredient"> = ({
  record: ingredient,
}) => {
  const { reparse } = useReparseUsage();
  return ingredient.recipeUsages.length > 0 ? (
    <RecipeUsagesTable
      usages={ingredient.recipeUsages}
      ingredientName={ingredient.name}
      aliases={ingredient.aliases}
      onReparse={reparse}
    />
  ) : (
    <Description>Not used in any recipes yet.</Description>
  );
};

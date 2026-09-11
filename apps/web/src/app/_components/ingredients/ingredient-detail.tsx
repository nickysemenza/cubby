import type {
  IngredientUpdateInput,
  IngredientWithFoodOut,
} from "@cubby/schemas/ingredient";
import type { ProductWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { uniqBy } from "es-toolkit";
import {
  Apple,
  ChefHat,
  Info,
  Scale,
  ShoppingCart,
  Sparkles,
} from "lucide-react";
import { type FC, useCallback, useState } from "react";

import { Stack } from "~/components/layout";
import type { DetailHeroStat } from "~/components/layouts/page-hero";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { sourceNutritionEstimate } from "~/lib/nutrition-format";
import {
  getAllUnitMappingsFromProduct,
  getIngredientMappings,
} from "~/lib/unit-mapping-utils";

import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { editableDetailSection } from "../data-table/editable-detail-section";
import { useEntityDetail } from "../hooks/useEntityDetail";
import { FullNutrientBreakdown } from "../nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "../nutrition/NutrientDensityStats";
import { NutritionLabel } from "../nutrition/NutritionLabel";
import { RecipeUsagesTable } from "../recipe/recipe-usages-table";
import { UnitCoveragePanel } from "../units/UnitCoveragePanel";
import { EnrichIngredientDialog } from "./enrich-ingredient-dialog";
import { IngredientBasicInfo } from "./ingredient-basic-info";
import { IngredientForm } from "./ingredient-form";
import { IngredientProductShelf } from "./ingredient-product-shelf";

interface IngredientDetailProps {
  ingredient: IngredientWithFoodOut;
}

/**
 * Nutrition and cost-per-nutrient must share one product's basis — pricing
 * one product's protein off a different product's nutrients would silently
 * misattribute cost. Deliberately pick the product carrying both (falling
 * back to nutrition alone when none has a price), rather than the previous
 * "any product with nutritionInfo" pick that left price unaccounted for.
 */
export function selectNutritionProduct(
  products: ProductWithMappingsAndFoodOut[],
): ProductWithMappingsAndFoodOut | undefined {
  return (
    products.find((p) => p.food?.nutritionInfo && p.price != null) ??
    products.find((p) => p.food?.nutritionInfo)
  );
}

export const IngredientDetail: FC<IngredientDetailProps> = ({ ingredient }) => {
  const [isEnriching, setIsEnriching] = useState(false);
  const startEnriching = useCallback(() => setIsEnriching(true), []);

  const { commonSections, editMode, mappings } = useEntityDetail<
    "ingredient",
    IngredientWithFoodOut,
    IngredientUpdateInput
  >({
    entity: "ingredient",
    data: ingredient,
    getMappings: getIngredientMappings,
  });

  // See selectNutritionProduct for why nutrition and price must come from
  // the same product.
  const nutritionProduct = selectNutritionProduct(ingredient.product);
  const nutritionInfo = nutritionProduct?.food?.nutritionInfo;
  const nutritionMappings = nutritionProduct
    ? getAllUnitMappingsFromProduct(nutritionProduct)
    : [];

  const sections: DetailSection[] = [
    editableDetailSection({
      id: "basic-information",
      title: "Basic Information",
      icon: Info,
      placement: "supporting",
      editMode,
      Form: IngredientForm,
      entity: ingredient,
      children: (
        <IngredientBasicInfo
          ingredient={ingredient}
          onEdit={editMode.startEditing}
        />
      ),
    }),
    // Custom section: Nutrition (only if available) — see nutritionProduct
    // above for which product supplies both the nutrients and the price.
    ...(nutritionInfo && nutritionProduct
      ? [
          {
            id: "nutrition-information",
            title: "Nutrition Information",
            icon: Apple,
            placement: "supporting" as const,
            content: (
              <Stack gap="md">
                <NutritionLabel
                  estimates={sourceNutritionEstimate(
                    nutritionInfo.nutrientsPer100,
                  )}
                  servingLabel="per 100 g"
                />
                <Description>
                  Shown from {nutritionProduct.name}
                  {nutritionProduct.manufacturer
                    ? ` by ${nutritionProduct.manufacturer}`
                    : ""}
                  .
                </Description>
                <NutrientDensityStats
                  nutrients={nutritionInfo.nutrientsPer100}
                  mappings={nutritionMappings}
                  price={
                    nutritionProduct.pricing.effectivePrice ??
                    nutritionProduct.price
                  }
                  mappingProduct={{
                    id: nutritionProduct.id,
                    name: nutritionProduct.name,
                    manufacturer: nutritionProduct.manufacturer,
                  }}
                />
                <FullNutrientBreakdown nutritionInfo={nutritionInfo} />
              </Stack>
            ),
          },
        ]
      : []),
    // Custom section: Related Products — the products realizing this
    // ingredient, as photo cards (primary content alongside recipe usages).
    {
      id: "related-products",
      title: "Related Products",
      icon: ShoppingCart,
      placement: "primary" as const,
      headerAction: (
        <Button variant="outline" size="sm" onClick={startEnriching}>
          <Sparkles className="size-4" />
          Enrich
        </Button>
      ),
      content: <IngredientProductShelf products={ingredient.product} />,
    },
    // Custom section: Unit Mappings — conversion capabilities + Convert modal
    // above the source-attributed table (table shows which product/food each
    // mapping came from, since ingredient mappings aggregate across products).
    {
      id: "unit-mappings",
      title: "Unit Mappings",
      icon: Scale,
      placement: "primary",
      content: <UnitCoveragePanel mappings={mappings} />,
    },
    // Custom section: Appears In Recipes — one row per usage, with amount,
    // source line, and a read-only parser-drift flag. Full-width so the 5-column
    // table has room (esp. the source line).
    {
      id: "recipe-appearances",
      title: "Appears In Recipes",
      icon: ChefHat,
      placement: "full",
      content:
        ingredient.recipeUsages.length > 0 ? (
          <RecipeUsagesTable
            usages={ingredient.recipeUsages}
            ingredientName={ingredient.name}
            aliases={ingredient.aliases}
          />
        ) : (
          <Description>Not used in any recipes yet.</Description>
        ),
    },
    // Common sections from entity config (History)
    ...commonSections,
  ];

  // Payload-derived placard stats — no extra queries.
  const heroStats: DetailHeroStat[] = [
    {
      label: "Recipes",
      value: uniqBy(ingredient.recipeUsages, (u) => u.recipe.id).length,
    },
    { label: "Products", value: ingredient.product.length },
  ];

  return (
    <>
      <Page
        variant="detail"
        entity="ingredient"
        title={ingredient.name}
        rawData={ingredient}
        heroStats={heroStats}
      >
        <DetailSections sections={sections} rawData={ingredient} />
      </Page>
      <EnrichIngredientDialog
        ingredient={
          isEnriching ? { id: ingredient.id, name: ingredient.name } : null
        }
        onOpenChange={(open) => {
          if (!open) setIsEnriching(false);
        }}
      />
    </>
  );
};

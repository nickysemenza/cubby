import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import { isNonFoodCategory } from "@cubby/shared";
import { useMemo } from "react";

import type { DetailSlotComponent } from "~/app/_components/entity-detail/detail-slots";
import {
  EntityDisplayImagesProvider,
  useEntityDisplayImage,
} from "~/app/_components/entity-media/entity-display-images";
import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { FullNutrientBreakdown } from "~/app/_components/nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "~/app/_components/nutrition/NutrientDensityStats";
import { ProductNutritionLabel } from "~/app/_components/nutrition/ProductNutritionLabel";
import { RecipeUsagesTable } from "~/app/_components/recipe/recipe-usages-table";
import { RelatednessRail } from "~/app/_components/relatedness/relatedness-rail";
import { UnitCoveragePanel } from "~/app/_components/units/UnitCoveragePanel";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { EntityFilterLink } from "~/components/ui/entity-filter-link";
import { labelNutrientsPer100 } from "~/lib/label-nutrition";
import { countLabel } from "~/lib/pluralize";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";

/**
 * Nutrition: a package-label override (`labelNutrition`) leads and takes
 * precedence over a linked USDA food's nutrients (matching costing precedence
 * in `productWasmInputs`); the USDA food's portions still feed the
 * per-serving toggle either way, and its full nutrient breakdown stays
 * reachable (superseded) behind its own disclosure when both exist.
 */
export const ProductNutrition: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const mappings = useMemo(
    () => getAllUnitMappingsFromProduct(product),
    [product],
  );
  const labelNutrition: ProductLabelNutrition | null = product.labelNutrition;
  const usdaNutritionInfo = product.food?.nutritionInfo ?? null;
  const nutrients = labelNutrition
    ? labelNutrientsPer100(labelNutrition)
    : usdaNutritionInfo?.nutrientsPer100;
  if (!nutrients)
    return (
      <Description>
        No nutrition on file — link a USDA food or enter the package label.
      </Description>
    );
  return (
    <Stack gap="md">
      <ProductNutritionLabel
        nutrients={nutrients}
        mappings={mappings}
        portions={product.food?.portionInfoRaw ?? []}
        servingGrams={labelNutrition?.servingGrams}
      />
      {labelNutrition && (
        <Description size="xs">
          From package label
          {labelNutrition.source ? ` · ${labelNutrition.source}` : ""}
        </Description>
      )}
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
      {usdaNutritionInfo && (
        <>
          {labelNutrition && (
            <Description size="xs">
              Superseded by the package label above — the USDA food&apos;s
              portions still apply to unit conversions.
            </Description>
          )}
          <FullNutrientBreakdown nutritionInfo={usdaNutritionInfo} />
        </>
      )}
    </Stack>
  );
};

/**
 * Conversion capabilities + Convert modal above the source-attributed rows.
 * Non-food (household/garage) products skip food-coverage grading (no
 * calories/price chips, no USDA nudge), and with no mappings at all collapse
 * to a note instead of an empty converter surface.
 */
export const ProductUnitMappings: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const mappings = useMemo(
    () => getAllUnitMappingsFromProduct(product),
    [product],
  );
  const isNonFood = isNonFoodCategory(product.category);
  if (isNonFood && mappings.length === 0)
    return (
      <Description>
        No unit conversions — not needed for non-food items.
      </Description>
    );
  return (
    <UnitCoveragePanel
      mappings={mappings}
      showCoverage={!isNonFood}
      servingAlias={{
        productId: product.id,
        storedMappings: product.unitMappings,
      }}
    />
  );
};

export const ProductFitsWith: DetailSlotComponent<"product"> = ({
  record: product,
}) => <RelatednessRail product={product} />;

/**
 * The cookbooks whose physical copies this product is. No query of its own:
 * the link arrives embedded in the product detail payload, so the panel
 * cannot contradict the page around it. The recipe count doubles as the
 * filter link into the recipe list.
 */
export const ProductCookbooks: DetailSlotComponent<"product"> = ({
  record: product,
}) => {
  const refs = useMemo(
    () =>
      product.cookbooks.map((cookbook) => ({
        entityType: "cookbook" as const,
        entityId: cookbook.id,
      })),
    [product.cookbooks],
  );
  return (
    <EntityDisplayImagesProvider refs={refs}>
      <Stack gap="sm">
        {product.cookbooks.map((cookbook) => (
          <CookbookLinkRow key={cookbook.id} cookbook={cookbook} />
        ))}
      </Stack>
    </EntityDisplayImagesProvider>
  );
};

function CookbookLinkRow({ cookbook }: { cookbook: ProductCookbooksProps }) {
  const displayImage = useEntityDisplayImage({
    entityType: "cookbook",
    entityId: cookbook.id,
  });
  return (
    <Row className="items-center justify-between gap-2">
      <EntityInlineLink
        displayImage={displayImage}
        entity="cookbook"
        data={{ id: cookbook.id, name: cookbook.name }}
      />
      <EntityFilterLink
        variant="value"
        to="/recipes"
        search={{ source: cookbook.id }}
        label={`Show all ${countLabel(cookbook.recipeCount, "recipe")} from ${cookbook.name}`}
      >
        {countLabel(cookbook.recipeCount, "recipe")}
      </EntityFilterLink>
    </Row>
  );
}

type ProductCookbooksProps = {
  id: string;
  name: string;
  recipeCount: number;
};

/** Recipes the product's linked ingredient is used in, one row per usage. */
export const ProductRecipeAppearances: DetailSlotComponent<"product"> = ({
  record: product,
}) =>
  product.ingredient && product.recipeUsages.length > 0 ? (
    <RecipeUsagesTable
      usages={product.recipeUsages}
      ingredientName={product.ingredient.name}
      aliases={product.ingredient.aliases}
    />
  ) : (
    <Description>Not used in any recipes yet.</Description>
  );

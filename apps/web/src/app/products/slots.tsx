import type { ProductLabelNutrition } from "@cubby/schemas/nutrition";
import { isNonFoodCategory } from "@cubby/shared";
import { type FunctionComponent, useMemo } from "react";

import type { CollectionActionProps } from "~/entity/entity-detail/collection-actions";
import { parseDrift } from "~/entity/entity-detail/collection-row-badges";
import type { DetailSlotComponent } from "~/entity/entity-detail/detail-slots";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { RelatednessRail } from "~/entity/relatedness/relatedness-rail";
import { FullNutrientBreakdown } from "~/features/nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "~/features/nutrition/NutrientDensityStats";
import { ProductNutritionLabel } from "~/features/nutrition/ProductNutritionLabel";
import { UnitCoveragePanel } from "~/features/units/UnitCoveragePanel";
import { labelNutrientsPer100 } from "~/lib/label-nutrition";
import { getAllUnitMappingsFromProduct } from "~/lib/unit-mapping-utils";
import { Stack } from "~/ui/layout";
import { Description } from "~/ui/primitives/description";

import { LabelNutritionReview } from "./label-nutrition-review";

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
  // Which source leads (and its captions) is the server's `nutritionDisplay`;
  // this only picks the matching per-100 g figures for the interactive panels.
  const display = product.nutritionDisplay;
  const nutrients =
    display.source === "label" && labelNutrition
      ? labelNutrientsPer100(labelNutrition)
      : display.source === "usda"
        ? usdaNutritionInfo?.nutrientsPer100
        : undefined;
  if (!nutrients) return <Description>{display.title}</Description>;
  return (
    <Stack gap="md">
      <ProductNutritionLabel
        nutrients={nutrients}
        mappings={mappings}
        portions={product.food?.portionInfoRaw ?? []}
        servingGrams={labelNutrition?.servingGrams}
        inferredZeroNutrients={labelNutrition?.inferredZeroNutrients}
      />
      {display.source === "label" && (
        <Description size="xs">
          {display.title}
          {display.sourceNote ? ` · ${display.sourceNote}` : ""}
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
          {display.source === "label" && (
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

/** The cookbooks whose physical copies this product is, from the server's report. */
export const ProductCookbooks: DetailSlotComponent<"product"> = ({
  record: product,
}) => (
  <EntityReportSlot slot="product.cookbooks" id={product.id} record={product} />
);

/**
 * Recipes the product's linked ingredient is used in, one row per usage, from the server's
 * report. The browser adds a badge to a line a fresh parse would change (the WASM parser runs
 * only here).
 */
export const ProductRecipeAppearances: DetailSlotComponent<"product"> = ({
  record: product,
}) => (
  <EntityReportSlot
    slot="product.recipe-appearances"
    id={product.id}
    record={product}
    rowBadges={(rows) => parseDrift(product, rows)}
  />
);

/** Package labels are retained as evidence but deliberately excluded from item covers. */
export const ProductLabels: DetailSlotComponent<"product"> = ({
  record: product,
}) => (
  <EntityReportSlot slot="product.labels" id={product.id} record={product} />
);

/**
 * Row action of the labels report: compares the detected nutrition for one package label against
 * the product's saved values. The label is looked up on the loaded product, so the review always
 * sees the evidence the row names.
 */
export const ReviewLabelNutritionAction: FunctionComponent<
  CollectionActionProps<"product">
> = ({ record: product, item }) => {
  const label = product.labelImages.find(
    (candidate) => candidate.id === item?.id,
  );
  return label ? (
    <LabelNutritionReview product={product} label={label} />
  ) : null;
};

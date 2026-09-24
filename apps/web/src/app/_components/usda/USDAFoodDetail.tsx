import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/usda";
import { BowlFoodIcon as Apple } from "@phosphor-icons/react/dist/csr/BowlFood";
import { ForkKnifeIcon as UtensilsCrossed } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { InfoIcon as Info } from "@phosphor-icons/react/dist/csr/Info";
import { LinkIcon as Link2 } from "@phosphor-icons/react/dist/csr/Link";
import { ScalesIcon as Scale } from "@phosphor-icons/react/dist/csr/Scales";
import { ScrollIcon as ScrollText } from "@phosphor-icons/react/dist/csr/Scroll";
import { useMemo } from "react";

import { Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { USDA_KINDS } from "~/lib/conversion-coverage";
import { sourceNutritionEstimate } from "~/lib/nutrition-format";
import {
  getAllUnitMappingsFromProduct,
  servingBasisUnit,
  unitMappingsFromFood,
} from "~/lib/unit-mapping-utils";

import { EntityActionButtons } from "../actions/entity-actions";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { EntityInlineLinkList } from "../EntityInlineLinkList";
import { FullNutrientBreakdown } from "../nutrition/FullNutrientBreakdown";
import { NutrientDensityStats } from "../nutrition/NutrientDensityStats";
import { NutritionLabel } from "../nutrition/NutritionLabel";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { UsdaFoodActions } from "./usda-food-actions";

function FoodNutrientDensity({
  food,
  linkedProducts,
  pricedProduct,
  mappings,
}: {
  food: FoodSummaryWithLinkedProducts;
  linkedProducts: FoodSummaryWithLinkedProducts["linkedProducts"];
  pricedProduct:
    | FoodSummaryWithLinkedProducts["linkedProducts"][number]
    | undefined;
  mappings: ReturnType<typeof getAllUnitMappingsFromProduct>;
}) {
  if (linkedProducts.length === 0) return null;
  const mappingProduct = pricedProduct ?? linkedProducts[0];
  if (!mappingProduct) return null;
  return (
    <NutrientDensityStats
      canSeeStoredMappings={false}
      nutrients={food.nutritionInfo.nutrientsPer100}
      mappings={mappings}
      price={
        pricedProduct
          ? (pricedProduct.pricing.effectivePrice ?? pricedProduct.price)
          : null
      }
      mappingProduct={{
        id: mappingProduct.id,
        name: mappingProduct.name,
        manufacturer: mappingProduct.manufacturer,
      }}
    />
  );
}

export const USDAFoodDetail: React.FC<{
  id: number;
  food: FoodSummaryWithLinkedProducts;
}> = ({ food }) => {
  const {
    brandedFoodInfo,
    foodInfo,
    nutritionInfo,
    portionInfoRaw,
    fdc_id,
    linkedProducts,
    legacyFoodInfo,
  } = food;

  // Load mappings
  const mappings = useMemo(() => unitMappingsFromFood(food), [food]);

  // Nutrient-density intel needs a priced product — an unlinked USDA food has
  // no price at all. Deliberately pick the first linked product that HAS one
  // (rather than just `linkedProducts[0]`), the same "pick one deliberately"
  // rule ingredient-detail follows, so a free/unpriced product earlier in the
  // list doesn't shadow a priced one. Falls back to the first linked product
  // only to give the "needs a weight mapping" nudge somewhere to link when
  // nothing is priced yet — that branch never renders a $ figure regardless.
  const pricedProduct = useMemo(
    () =>
      linkedProducts.find((p) => (p.pricing.effectivePrice ?? p.price) != null),
    [linkedProducts],
  );
  const nutrientDensityMappings = useMemo(
    () =>
      pricedProduct
        ? getAllUnitMappingsFromProduct({
            id: pricedProduct.id,
            // This product's own stored conversions aren't available on the
            // food-detail page's `linkedProducts` projection (no unitMappings
            // field) — only its food-derived + price edges resolve here. A
            // product with a stored "1 each = X g" mapping still resolves
            // correctly on its own detail page.
            unitMappings: [],
            food,
            // This USDA-food-centric view has no reach into a linked
            // product's own label override; the food's own nutrients are
            // what's being inspected here regardless.
            labelNutrition: null,
            price: pricedProduct.price,
            pricing: pricedProduct.pricing,
          })
        : [],
    [pricedProduct, food],
  );

  const foodInfoSection = (
    <div>
      <div className="mb-2">FDC ID: {fdc_id}</div>
      <div>type: {foodInfo.data_type}</div>

      {legacyFoodInfo && <div>NDB: {legacyFoodInfo.ndb_number}</div>}

      {brandedFoodInfo && (
        <Stack gap="sm">
          {brandedFoodInfo.brand_name && (
            <div>Brand: {brandedFoodInfo.brand_name}</div>
          )}
          {brandedFoodInfo.brand_owner && (
            <div>Manufacturer: {brandedFoodInfo.brand_owner}</div>
          )}
          {brandedFoodInfo.branded_food_category && (
            <div>Category: {brandedFoodInfo.branded_food_category}</div>
          )}
          {brandedFoodInfo.gtin_upc && (
            <div>UPC: {brandedFoodInfo.gtin_upc}</div>
          )}
        </Stack>
      )}
    </div>
  );

  const ingredientsSection = brandedFoodInfo?.ingredients ? (
    <div className="text-sm whitespace-pre-wrap">
      {brandedFoodInfo.ingredients}
    </div>
  ) : (
    <div className="text-muted-foreground">
      No ingredients information available
    </div>
  );

  const servingInfoSection = (
    <div>
      {brandedFoodInfo?.serving && (
        <Stack gap="sm">
          {brandedFoodInfo.serving.serving_size &&
            brandedFoodInfo.serving.serving_size_unit && (
              <div>
                Serving size: {brandedFoodInfo.serving.serving_size}{" "}
                {brandedFoodInfo.serving.serving_size_unit}
              </div>
            )}
          {brandedFoodInfo.serving.household_serving_fulltext && (
            <div>
              Household serving:{" "}
              {brandedFoodInfo.serving.household_serving_fulltext}
            </div>
          )}
        </Stack>
      )}
      {portionInfoRaw.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 font-heading font-medium">Portion Information</h4>
          <Table className="table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>Amount</TableHead>
                <TableHead>Portion</TableHead>
                <TableHead>Grams</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {portionInfoRaw.map((portion) => (
                <TableRow
                  key={`${portion.amount}-${portion.modifier ?? "default"}-${portion.gram_weight}`}
                >
                  <TableCell>{portion.amount}</TableCell>
                  <TableCell>{portion.modifier || "portion"}</TableCell>
                  <TableCell>{portion.gram_weight}g</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );

  const nutrientBasis = servingBasisUnit(food);

  const nutritionSection = (
    <Stack gap="sm">
      <NutritionLabel
        estimates={sourceNutritionEstimate(nutritionInfo.nutrientsPer100)}
        servingLabel={`per 100 ${nutrientBasis === "ml" ? "mL" : "g"}`}
      />
      {/* An unlinked food has no price — gate on a linked product existing at
          all, per the linkedProducts.length check below. */}
      <FoodNutrientDensity
        food={food}
        linkedProducts={linkedProducts}
        pricedProduct={pricedProduct}
        mappings={nutrientDensityMappings}
      />
      <FullNutrientBreakdown nutritionInfo={nutritionInfo} />
    </Stack>
  );

  const unitMappingsSection = (
    <UnitMappingDisplay mappings={mappings} title="" kinds={USDA_KINDS} />
  );

  // Section for displaying linked products
  const linkedProductsSection = (
    <div>
      {linkedProducts.length === 0 ? (
        <div className="text-muted-foreground">
          No associated products found
        </div>
      ) : (
        <EntityInlineLinkList entity="product" items={linkedProducts} />
      )}
    </div>
  );

  const sections: DetailSection[] = [
    {
      id: "food-information",
      title: "Food Information",
      icon: Info,
      placement: "supporting",
      content: foodInfoSection,
    },
    {
      id: "associated-products",
      title: "Associated Products",
      icon: Link2,
      placement: "supporting",
      content: linkedProductsSection,
    },
    {
      id: "nutrition-information",
      title: "Nutrition Information",
      icon: Apple,
      placement: "primary",
      content: nutritionSection,
    },
    {
      id: "serving-information",
      title: "Serving Information",
      icon: UtensilsCrossed,
      placement: "primary",
      content: servingInfoSection,
    },
    {
      id: "branded-ingredients",
      title: "Branded Food Ingredients",
      icon: ScrollText,
      placement: "primary",
      content: ingredientsSection,
    },
    {
      id: "unit-conversions",
      title: "Unit Conversions",
      icon: Scale,
      placement: "supporting",
      content: unitMappingsSection,
    },
  ];

  return (
    <Page
      variant="detail"
      entity="usda-food"
      title={foodInfo.description || "Unnamed Food"}
      rawData={food}
      heroActions={{
        // `UsdaFoodActions` is this page's own custom action set; the
        // registry contributes `copyIdentifiers` (the one verb declared for
        // `usda-food`) — `DetailSections` no longer surfaces registry verbs
        // in the strip, so this is now the only place either renders.
        secondary: (overflow) => (
          <>
            <UsdaFoodActions food={food} />
            <EntityActionButtons
              entity="usda-food"
              record={{ id: String(fdc_id) }}
              overflow={overflow}
            />
          </>
        ),
      }}
    >
      <DetailSections sections={sections} rawData={food} />
    </Page>
  );
};

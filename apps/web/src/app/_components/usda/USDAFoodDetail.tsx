import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import {
  Apple,
  Info,
  Link2,
  Scale,
  ScrollText,
  UtensilsCrossed,
} from "lucide-react";
import { useMemo } from "react";
import { Page } from "~/components/page/Page";
import { USDA_KINDS } from "~/lib/conversion-coverage";
import { unitMappingsFromFood } from "~/lib/unit-mapping-utils";
import { type DetailSection, DetailSections } from "../data-table/detail-page";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { NutrientsSummary } from "../units/NutrientsSummary";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";
import { NutritionInfoTable } from "./nutrition";

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

  const foodInfoSection = (
    <div>
      <div className="mb-2">FDC ID: {fdc_id}</div>
      <div>type: {foodInfo.data_type}</div>

      {legacyFoodInfo && <div>NDB: {legacyFoodInfo.ndb_number}</div>}

      {brandedFoodInfo && (
        <div className="space-y-2">
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
        </div>
      )}
    </div>
  );

  const ingredientsSection = brandedFoodInfo?.ingredients ? (
    <div className="whitespace-pre-wrap text-sm">
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
        <div className="space-y-2">
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
        </div>
      )}
      {portionInfoRaw.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 font-heading font-medium">Portion Information</h4>
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="bg-muted">
                <th className="border p-2 text-left">Amount</th>
                <th className="border p-2 text-left">Portion</th>
                <th className="border p-2 text-left">Grams</th>
              </tr>
            </thead>
            <tbody>
              {portionInfoRaw.map((portion) => (
                <tr
                  key={`${portion.amount}-${portion.modifier ?? "default"}-${portion.gram_weight}`}
                  className="border-b"
                >
                  <td className="border p-2">{portion.amount}</td>
                  <td className="border p-2">
                    {portion.modifier || "portion"}
                  </td>
                  <td className="border p-2">{portion.gram_weight}g</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const nutritionSection = (
    <div>
      <p className="mb-3 text-muted-foreground text-sm">Per 100g</p>
      <div className="mb-4">
        <NutrientsSummary nutrients={nutritionInfo.nutrientsPer100} />
      </div>
      <NutritionInfoTable n={nutritionInfo} />
    </div>
  );

  const unitMappingsSection = (
    <UnitMappingDisplay mappings={mappings} title="" kinds={USDA_KINDS} />
  );

  // Section for displaying linked products
  const linkedProductsSection = (
    <div>
      {!linkedProducts || linkedProducts.length === 0 ? (
        <div className="text-muted-foreground">
          No associated products found
        </div>
      ) : (
        <EntityPillLinkList entity="product" items={linkedProducts} />
      )}
    </div>
  );

  const sections: DetailSection[] = [
    { title: "Food Information", icon: Info, content: foodInfoSection },
    {
      title: "Associated Products",
      icon: Link2,
      content: linkedProductsSection,
    },
    { title: "Nutrition Information", icon: Apple, content: nutritionSection },
    {
      title: "Serving Information",
      icon: UtensilsCrossed,
      content: servingInfoSection,
    },
    {
      title: "Branded Food Ingredients",
      icon: ScrollText,
      content: ingredientsSection,
    },
    { title: "Unit Conversions", icon: Scale, content: unitMappingsSection },
  ];

  return (
    <Page
      variant="detail"
      entity="usda-food"
      title={foodInfo.description || "Unnamed Food"}
      rawData={food}
    >
      <DetailSections sections={sections} rawData={food} />
    </Page>
  );
};

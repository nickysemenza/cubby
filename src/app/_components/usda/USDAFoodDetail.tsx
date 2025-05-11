"use client";

import { FoodSummary } from "~/schemas/usda";
import { NutritionInfoTable } from "./nutrition";
import { unitMappingsFromFood } from "~/schemas/combo";
import { ProductPillLink } from "../EntityPill";
import { DetailPage, DetailSection } from "../data-table/detail-page";
import { EntityPillLinkList } from "../EntityPillLinkList";
import { UnitMappingDisplay } from "../units/UnitMappingDisplay";

export const USDAFoodDetail: React.FC<{ id: number; food: FoodSummary }> = ({
  food,
}) => {
  const {
    brandedFoodInfo,
    foodInfo,
    nutritionInfo,
    portionInfo,
    fdc_id,
    linkedProducts,
    legacyFoodInfo,
  } = food;

  // Debug linked products issue
  console.log("Food object:", food);
  console.log("Linked products:", linkedProducts);
  const mappings = unitMappingsFromFood(food);

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
    <div>
      <h3 className="mb-3">Ingredients</h3>
      <div className="text-sm whitespace-pre-wrap">
        {brandedFoodInfo.ingredients}
      </div>
    </div>
  ) : (
    <div>No ingredients information available</div>
  );

  const servingInfoSection = (
    <div>
      <h3 className="mb-3">Serving Information</h3>
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
      {portionInfo.raw.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 font-semibold">Portion Information</h4>
          <table className="min-w-full border-collapse">
            <thead>
              <tr className="bg-gray-100">
                <th className="border p-2 text-left">Amount</th>
                <th className="border p-2 text-left">Portion</th>
                <th className="border p-2 text-left">Grams</th>
              </tr>
            </thead>
            <tbody>
              {portionInfo.raw.map((portion, idx) => (
                <tr key={idx} className="border-b">
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
      <h3 className="mb-3">Nutrition per 100g</h3>
      <div className="mb-4 flex">
        <div className="mr-6">
          <div className="font-semibold">Energy</div>
          <div>{nutritionInfo.nutrientsPer100.kcal} kcal</div>
        </div>
        <div>
          <div className="font-semibold">Protein</div>
          <div>{nutritionInfo.nutrientsPer100.protein}g</div>
        </div>
      </div>
      <NutritionInfoTable n={nutritionInfo} />
    </div>
  );

  const unitMappingsSection = <UnitMappingDisplay mappings={mappings} />;

  // Section for displaying linked products
  const linkedProductsSection = (
    <div>
      <h3 className="mb-3">Associated Products</h3>
      {!linkedProducts || linkedProducts.length === 0 ? (
        <div className="text-gray-500 italic">No associated products found</div>
      ) : (
        <div className="space-y-4">
          <EntityPillLinkList
            items={linkedProducts}
            Pill={ProductPillLink}
            pillPropName="product"
          />
        </div>
      )}
    </div>
  );

  const sections: DetailSection[] = [
    { title: "Food Information", content: foodInfoSection },
    { title: "Associated Products", content: linkedProductsSection },
    { title: "Nutrition Information", content: nutritionSection },
    { title: "Serving Information", content: servingInfoSection },
    { title: "Branded Food Ingredients", content: ingredientsSection },
    { title: "Unit Conversions", content: unitMappingsSection },
  ];

  return (
    <DetailPage
      sections={sections}
      entity="usda-food"
      name={foodInfo.description}
    />
  );
};

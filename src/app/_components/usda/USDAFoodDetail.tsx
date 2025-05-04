"use client";

import { FoodSummary } from "~/schemas/usda";
import { useWasm } from "~/wasmContext";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { NutritionInfoTable } from "./nutrition";
import { unitMappingsFromFood } from "~/schemas/combo";
import { EntityPill } from "../EntityPill";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";
import { DetailPage, DetailSection } from "../data-table/detail-page";

export const USDAFoodDetail: React.FC<{ id: number; food: FoodSummary }> = ({
  food,
}) => {
  const { brandedFoodInfo, foodInfo, nutritionInfo, portionInfo, fdc_id } =
    food;
  const { w } = useWasm();
  const mappings = unitMappingsFromFood(food);

  const foodInfoSection = (
    <div>
      <h2 className="mb-3">
        {foodInfo.description}
        <EntityPill text={foodInfo.data_type} />
      </h2>
      <div className="mb-2">FDC ID: {fdc_id}</div>
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

  const unitMappingsSection = w ? (
    <div>
      <h3 className="mb-3">Unit Conversions</h3>
      <UnitMappingsTable mappings={mappings} w={w} />
      {buildunitMappingsGraph(w, mappings)}
    </div>
  ) : (
    <div>Loading unit mappings...</div>
  );

  const sections: DetailSection[] = [
    { title: "Food Information", content: foodInfoSection },
    { title: "Nutrition Information", content: nutritionSection },
    { title: "Serving Information", content: servingInfoSection },
    { title: "Branded Food Ingredients", content: ingredientsSection },
    { title: "Unit Conversions", content: unitMappingsSection },
  ];

  return <DetailPage sections={sections} entity="usda-food" />;
};

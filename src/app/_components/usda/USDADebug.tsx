"use client";

import { FoodSummary } from "~/schemas/usda";
import { useWasm } from "~/wasmContext";
import JsonRenderer from "../json-renderer";
import { UnitMappingsTable } from "../units/unitmappingstable";
import { NutritionInfoTable } from "./nutrition";
import { unitMappingsFromFood } from "~/schemas/combo";
import { EntityPill } from "../EntityPill";
import { buildunitMappingsGraph } from "../units/UnitMappingGraph";

export const USDADebug: React.FC<{ id: number; food: FoodSummary }> = ({
  food,
}) => {
  const {
    brandedFoodInfo,
    foodInfo,
    nutritionInfo,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    portionInfo,
    fdc_id,
    ...rest
  } = food;
  const { w } = useWasm();
  const mappings = unitMappingsFromFood(food);
  return (
    <div>
      <h2>
        {food.foodInfo.description}
        <EntityPill text={food.foodInfo.data_type} />
      </h2>
      {fdc_id}
      <div className="flex">
        <div className="w-1/2">
          <h3>nutrition per 100g</h3>
          <NutritionInfoTable n={nutritionInfo} />
        </div>
        {w && (
          <div className="w-1/2">
            <UnitMappingsTable mappings={mappings} w={w} />
            {buildunitMappingsGraph(w, mappings)}
            <JsonRenderer input={{ brandedFoodInfo, rest, foodInfo }} />
          </div>
        )}
      </div>
    </div>
  );
};

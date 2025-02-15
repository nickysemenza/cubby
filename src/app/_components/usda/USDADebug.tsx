"use client";

import { useContext } from "react";
import { FoodSummary } from "~/schemas/usda";
import { WasmContext } from "~/wasmContext";
import JsonRenderer from "../json";
import { UnitMappingsTable } from "../unitmappingstable";
import { NutritionInfoTable } from "./nutrition";
import { unitMappingsFromFood } from "~/schemas/combo";
import { Pill } from "../EntityPill";
import { buildunitMappingsGraph } from "../UnitMappingGraph";

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
  const w = useContext(WasmContext);
  const mappings = unitMappingsFromFood(food);
  return (
    <div>
      <h2>
        {food.foodInfo.description}
        <Pill text={food.foodInfo.data_type} />
      </h2>
      {fdc_id}
      <div className="flex">
        <div className="w-1/2">
          <h3>nutrition per 100g</h3>
          <NutritionInfoTable n={nutritionInfo} />
        </div>
        <div className="w-1/2">
          <UnitMappingsTable mappings={mappings} w={w} />
          {buildunitMappingsGraph(w, mappings)}
          <JsonRenderer input={{ brandedFoodInfo, rest, foodInfo }} />
        </div>
      </div>
    </div>
  );
};
